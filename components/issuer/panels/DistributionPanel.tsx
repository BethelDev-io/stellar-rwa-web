"use client";

import { useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import type { AssetDetail } from "@/types";
import type { Network } from "@/types";
import { assetToken, contractIds, dividend } from "@/lib/contracts";
import { useTx } from "@/hooks/useTx";
import { useAsync } from "@/hooks/useAsync";
import { useWallet } from "@/hooks/useWallet";
import { getLatestLedger } from "@/lib/stellar";
import { useDividends } from "@/hooks/useDividends";
import { fetchOnChainHolders, useHolders, type Holder } from "@/hooks/useHolders";
import { parseTokenAmount, formatTokenAmount, truncateAddress } from "@/lib/format";
import { arg } from "@/lib/stellar";
import { ActionCard } from "@/components/issuer/ActionCard";
import { TxProgress } from "@/components/ui/TxProgress";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { percent } from "@/lib/format";

// ---- Known-token presets (#323) ----
//
// Issuers most commonly pay dividends in the native XLM Stellar Asset Contract
// (SAC) or in a USDC-equivalent stablecoin. Hard-coding the well-known
// testnet/mainnet contract IDs here lets the form surface a one-click shortcut
// so the issuer doesn't have to find and paste the address manually.
//
// The XLM SAC is deterministic: on testnet it is the SEP-41 wrapper for the
// native XLM asset deployed by the Stellar Development Foundation.
// Sources:
//   Testnet  – https://stellar.expert/explorer/testnet/contract/CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN4
//   Mainnet  – https://stellar.expert/explorer/public/contract/CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA

interface KnownToken {
  label: string;
  symbol: string;
  contractId: string;
}

const KNOWN_TOKENS: Record<Network, KnownToken[]> = {
  testnet: [
    {
      label: "Native XLM (SAC)",
      symbol: "XLM",
      contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN4",
    },
  ],
  mainnet: [
    {
      label: "Native XLM (SAC)",
      symbol: "XLM",
      contractId: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
    },
  ],
};

// Leave room for the rest of the transaction envelope and its auth data.
const MAX_SNAPSHOT_XDR_BYTES = 48 * 1024;

interface DistributionPanelProps {
  asset: AssetDetail;
  onCreated?: () => void;
  isAdmin?: boolean;
}

/** Create new dividend distributions and view existing ones for the asset. */
export function DistributionPanel({ asset, onCreated, isAdmin = true }: DistributionPanelProps) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-xs text-base-100/50">
        <strong>Required role:</strong> dividend contract caller must be registered issuer for this asset
      </div>
      <CreateDistributionCard
        tokenContract={asset.tokenContract}
        complianceContract={asset.metadata.complianceContract}
        assetDecimals={asset.metadata.decimals}
        assetSymbol={asset.metadata.symbol}
        {...(onCreated !== undefined ? { onCreated } : {})}
        isAdmin={isAdmin}
      />
      <ExistingDistributionsCard tokenContract={asset.tokenContract} isAdmin={isAdmin} />
    </div>
  );
}

// ---- Create distribution ----

function sameHolderSnapshot(left: Holder[], right: Holder[]): boolean {
  if (left.length !== right.length) return false;
  const balancesByAddress = new Map(left.map(({ address, balance }) => [address, balance]));
  return right.every(
    ({ address, balance }) => balancesByAddress.get(address) === balance,
  );
}

function CreateDistributionCard({
  tokenContract,
  complianceContract,
  assetDecimals,
  assetSymbol,
  onCreated,
  isAdmin = true,
}: {
  tokenContract: string;
  complianceContract: string;
  assetDecimals: number;
  assetSymbol: string;
  onCreated?: () => void;
  isAdmin?: boolean;
}) {
  const tx = useTx();
  const { address, network } = useWallet();
  const [paymentToken, setPaymentToken] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [claimDeadline, setClaimDeadline] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [snapshotRefreshing, setSnapshotRefreshing] = useState(false);
  const [refreshedSnapshot, setRefreshedSnapshot] = useState<{
    key: string;
    holders: Holder[];
  } | null>(null);
  const holderState = useHolders(complianceContract, tokenContract);
  const snapshotKey = `${complianceContract}:${tokenContract}`;
  const holderSnapshot =
    refreshedSnapshot?.key === snapshotKey
      ? refreshedSnapshot.holders
      : holderState.data;
  const snapshotTotal = (holderSnapshot ?? []).reduce(
    (total, holder) => total + holder.balance,
    0n,
  );

  // Only fetch when the input looks like a valid contract address.
  const isValidPt =
    paymentToken.trim().length > 0 &&
    (StrKey.isValidContract(paymentToken.trim()) ||
      StrKey.isValidEd25519PublicKey(paymentToken.trim()));

  // #293: Show the issuer's balance in the payment token before they submit.
  const { data: balanceData, loading: balanceLoading } = useAsync(
    async () => ({
      token: paymentToken.trim(),
      amount: await assetToken.balance(network, paymentToken.trim(), address!),
    }),
    [network, paymentToken, address],
    isValidPt && !!address,
  );
  const balance = balanceData?.token === paymentToken.trim() ? balanceData.amount : null;

  // #293: Show how much the dividend contract is already approved to pull.
  // Issuers need to approve at least totalAmount before the distribution can be funded.
  const dividendContractId = contractIds(network).dividend;
  const { data: allowanceData, loading: allowanceLoading } = useAsync(
    async () => ({
      token: paymentToken.trim(),
      amount: await assetToken.allowance(network, paymentToken.trim(), address!, dividendContractId),
    }),
    [network, paymentToken, address, dividendContractId],
    isValidPt && !!address,
  );
  const allowance = allowanceData?.token === paymentToken.trim() ? allowanceData.amount : null;

  const { data: decimalsData, loading: decimalsLoading, error: decimalsError } = useAsync(
    async () => ({
      token: paymentToken.trim(),
      decimals: await assetToken.decimals(network, paymentToken.trim()),
    }),
    [network, paymentToken],
    isValidPt,
  );
  const paymentTokenDecimals =
    decimalsData?.token === paymentToken.trim() ? decimalsData.decimals : null;

  // Parse the requested amount for comparison (best-effort; errors handled on submit).
  let requestedRaw: bigint | null = null;
  try {
    if (totalAmount.trim() && paymentTokenDecimals !== null) {
      requestedRaw = parseTokenAmount(totalAmount, paymentTokenDecimals);
    }
  } catch {
    // handled at submit time
  }

  const insufficientBalance = balance !== null && requestedRaw !== null && requestedRaw > balance;
  const needsApproval = allowance !== null && requestedRaw !== null && requestedRaw > allowance;

  // Submit-time errors are attributed to the field they concern.
  const tokenInvalid = !!formError && /payment token/i.test(formError);
  const totalFormInvalid = !!formError && !tokenInvalid;
  const totalInvalid = insufficientBalance || totalFormInvalid;
  const totalErrorIds =
    [
      totalFormInvalid && "dist-form-error",
      (insufficientBalance || needsApproval) && "dist-total-error",
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const pt = paymentToken.trim();
    if (!StrKey.isValidContract(pt) && !StrKey.isValidEd25519PublicKey(pt)) {
      setFormError("Enter a valid payment token contract address (C…).");
      return;
    }

    let raw: bigint;
    try {
      const decimals = await assetToken.decimals(network, pt);
      raw = parseTokenAmount(totalAmount, decimals);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Invalid total amount.");
      return;
    }

    if (raw <= 0n) {
      setFormError("Total amount must be greater than zero.");
      return;
    }

    const deadline = claimDeadline.trim() ? Number(claimDeadline) : 0;
    if (!Number.isFinite(deadline) || deadline < 0) {
      setFormError("Claim deadline must be a non-negative ledger number.");
      return;
    }

    const holders = holderSnapshot ?? [];
    if (holders.length === 0) {
      setFormError("No eligible holders found for this asset.");
      return;
    }

    const snapshotXdr = JSON.stringify(
      holders.map(({ address: holderAddress, balance: holderBalance }) => ({
        address: holderAddress,
        balance: holderBalance.toString(),
      })),
    );
    if (snapshotXdr.length > MAX_SNAPSHOT_XDR_BYTES) {
      setFormError("Holder snapshot is too large to submit in a single transaction.");
      return;
    }

    const latestLedger = await getLatestLedger(network);
    const resolvedDeadline = deadline > 0 ? deadline : latestLedger + 100;

    await tx.run(
      () =>
        dividend.createDistribution(
          network,
          address!,
          tokenContract,
          pt,
          raw,
          resolvedDeadline,
          holders.map(({ address: holderAddress, balance: holderBalance }) => ({
            address: holderAddress,
            amount: holderBalance,
          })),
        ),
      {
        onSuccess: () => {
          setPaymentToken("");
          setTotalAmount("");
          setClaimDeadline("");
          onCreated?.();
        },
      },
    );
  }

  async function refreshSnapshot() {
    setSnapshotRefreshing(true);
    try {
      const holders = await fetchOnChainHolders(network, complianceContract, tokenContract);
      setRefreshedSnapshot({ key: snapshotKey, holders });
    } finally {
      setSnapshotRefreshing(false);
    }
  }

  return (
    <ActionCard
      title="Create distribution"
      description="Snapshot eligible holders and fund a new dividend distribution."
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="dist-payment-token" className="block text-sm font-medium text-base-100/80">
            Payment token
          </label>
          <input
            id="dist-payment-token"
            type="text"
            value={paymentToken}
            onChange={(e) => setPaymentToken(e.target.value)}
            placeholder="C…"
            aria-invalid={tokenInvalid}
            aria-describedby={tokenInvalid ? "dist-form-error" : undefined}
            className="mt-1 w-full rounded-lg border border-white/10 bg-base-900/60 px-3 py-2 text-sm text-base-100 placeholder:text-base-100/30 focus:border-primary focus:outline-none"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {KNOWN_TOKENS[network].map((token) => (
              <button
                key={token.contractId}
                type="button"
                onClick={() => setPaymentToken(token.contractId)}
                className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-base-100/70 hover:border-primary hover:text-primary"
              >
                {token.label}
              </button>
            ))}
          </div>
          {isValidPt && (
            <p className="mt-1 text-xs text-base-100/50">
              {balanceLoading || allowanceLoading ? (
                <Spinner size="sm" />
              ) : (
                <>
                  Balance: {balance !== null ? formatTokenAmount(balance, paymentTokenDecimals ?? 7) : "—"}
                  {" · "}
                  Approved: {allowance !== null ? formatTokenAmount(allowance, paymentTokenDecimals ?? 7) : "—"}
                </>
              )}
            </p>
          )}
          {decimalsError && (
            <p className="mt-1 text-xs text-red-400">Could not read token decimals.</p>
          )}
        </div>

        <div>
          <label htmlFor="dist-total" className="block text-sm font-medium text-base-100/80">
            Total amount ({assetSymbol})
          </label>
          <input
            id="dist-total"
            type="text"
            inputMode="decimal"
            value={totalAmount}
            onChange={(e) => setTotalAmount(e.target.value)}
            placeholder="0.00"
            aria-invalid={totalInvalid}
            aria-describedby={totalErrorIds}
            className="mt-1 w-full rounded-lg border border-white/10 bg-base-900/60 px-3 py-2 text-sm text-base-100 placeholder:text-base-100/30 focus:border-primary focus:outline-none"
          />
          {insufficientBalance && (
            <p id="dist-total-error" className="mt-1 text-xs text-red-400">
              Amount exceeds your payment-token balance.
            </p>
          )}
          {needsApproval && (
            <p className="mt-1 text-xs text-amber-400">
              The dividend contract needs an allowance of at least this amount.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="dist-deadline" className="block text-sm font-medium text-base-100/80">
            Claim deadline (ledger, optional)
          </label>
          <input
            id="dist-deadline"
            type="text"
            inputMode="numeric"
            value={claimDeadline}
            onChange={(e) => setClaimDeadline(e.target.value)}
            placeholder="e.g. 1234567"
            className="mt-1 w-full rounded-lg border border-white/10 bg-base-900/60 px-3 py-2 text-sm text-base-100 placeholder:text-base-100/30 focus:border-primary focus:outline-none"
          />
        </div>

        <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-xs text-base-100/60">
          <div className="flex items-center justify-between">
            <span>
              Eligible holders: {holderSnapshot?.length ?? 0} · Total: {formatTokenAmount(snapshotTotal, assetDecimals)} {assetSymbol}
            </span>
            <button
              type="button"
              onClick={refreshSnapshot}
              disabled={snapshotRefreshing}
              className="text-primary hover:underline disabled:opacity-50"
            >
              {snapshotRefreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {formError && (
          <p id="dist-form-error" className="text-sm text-red-400">
            {formError}
          </p>
        )}

        <TxProgress state={tx.state} />

        <button
          type="submit"
          disabled={tx.state.status === "pending"}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
        >
          {tx.state.status === "pending" ? "Creating…" : "Create distribution"}
        </button>
      </form>
    </ActionCard>
  );
}

// ---- Existing distributions ----

function ExistingDistributionsCard({
  tokenContract,
  isAdmin = true,
}: {
  tokenContract: string;
  isAdmin?: boolean;
}) {
  const { address, network } = useWallet();
  const { data, loading, error, refetch } = useDividends(tokenContract);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const cancelTx = useTx();

  async function onCancel(distributionId: number) {
    await cancelTx.run(
      () =>
        dividend.cancelDistribution(network, address!, tokenContract, distributionId),
      {
        onSuccess: () => {
          setConfirmingId(null);
          refetch();
        },
      },
    );
  }

  if (loading) {
    return (
      <ActionCard title="Distributions" description="Existing dividend distributions for this asset.">
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      </ActionCard>
    );
  }

  if (error) {
    return (
      <ActionCard title="Distributions" description="Existing dividend distributions for this asset.">
        <ErrorState message={error} onRetry={refetch} />
      </ActionCard>
    );
  }

  const distributions = data ?? [];

  return (
    <ActionCard title="Distributions" description="Existing dividend distributions for this asset.">
      {distributions.length === 0 ? (
        <EmptyState title="No distributions yet" description="Create one above to get started." />
      ) : (
        <ul className="divide-y divide-white/5">
          {distributions.map((distribution) => {
            const isConfirming = confirmingId === distribution.id;
            const canCancel = isAdmin && !!address && distribution.status === "active";
            return (
              <li key={distribution.id} className="py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-base-100">
                      #{distribution.id} · {formatTokenAmount(distribution.totalAmount, distribution.decimals)} {distribution.symbol}
                    </p>
                    <p className="text-xs text-base-100/50">
                      {distribution.status} · {percent(distribution.claimedPercent)} claimed
                    </p>
                  </div>
                  {canCancel && !isConfirming && (
                    <button
                      type="button"
                      onClick={() => setConfirmingId(distribution.id)}
                      className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10"
                    >
                      Cancel
                    </button>
                  )}
                </div>
                {canCancel && isConfirming && (
                  <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2">
                    <p className="text-xs text-base-100/70">
                      Cancel distribution #{distribution.id}? Unclaimed funds will be returned to the issuer.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => onCancel(distribution.id)}
                        disabled={cancelTx.state.status === "pending"}
                        className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500/90 disabled:opacity-50"
                      >
                        {cancelTx.state.status === "pending" ? "Cancelling…" : "Confirm cancel"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingId(null)}
                        disabled={cancelTx.state.status === "pending"}
                        className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-base-100/70 hover:bg-white/5 disabled:opacity-50"
                      >
                        Keep
                      </button>
                    </div>
                    <TxProgress state={cancelTx.state} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </ActionCard>
  );
}
