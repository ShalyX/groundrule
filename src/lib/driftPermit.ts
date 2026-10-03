import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus, type CalldataEncodable, type Hash } from "genlayer-js/types";
import {
  normalizeDependency,
  normalizeAction,
  normalizePermit,
  type ActionView,
  type DependencyView,
  type PermitView,
} from "./domain";

export const DRIFTPERMIT_ADDRESS = (import.meta.env.VITE_DRIFTPERMIT_CONTRACT_ADDRESS ??
  "0x4Bdb443424bEe8dd22809dd0B76755109aC89615") as `0x${string}`;
export const GUARDED_CONSUMER_ADDRESS = (import.meta.env.VITE_GUARDED_CONSUMER_ADDRESS ??
  "0x4cEdAc7a470d81EFC151564d5887Ba616bF56C31") as `0x${string}`;
export const STUDIONET_RPC_URL =
  import.meta.env.VITE_STUDIONET_RPC_URL?.trim() || "/api/studionet";

const PUBLIC_STUDIONET_RPC_URL = "https://studio.genlayer.com/api";
const STUDIONET_CHAIN_ID = `0x${studionet.id.toString(16)}`;

export type WalletProvider = NonNullable<Window["ethereum"]>;

function providerErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function isUnknownChainError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
  return providerErrorCode(error) === 4902 || message.includes("unknown chain") || message.includes("unrecognized chain");
}

async function ensureStudionetNetwork(provider: WalletProvider): Promise<void> {
  const currentChainId = String(await provider.request({ method: "eth_chainId" }) || "").toLowerCase();
  if (currentChainId === STUDIONET_CHAIN_ID) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: STUDIONET_CHAIN_ID }],
    });
    return;
  } catch (error) {
    if (!isUnknownChainError(error)) {
      throw new Error(`Switch your wallet to GenLayer Studio Network (chain ${studionet.id}) before continuing.`);
    }
  }

  await provider.request({
    method: "wallet_addEthereumChain",
    params: [{
      chainId: STUDIONET_CHAIN_ID,
      chainName: studionet.name,
      rpcUrls: [PUBLIC_STUDIONET_RPC_URL],
      nativeCurrency: studionet.nativeCurrency,
      blockExplorerUrls: [studionet.blockExplorers?.default.url],
    }],
  });
  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: STUDIONET_CHAIN_ID }],
  });
}

function readClient() {
  return createClient({ chain: studionet, endpoint: STUDIONET_RPC_URL });
}

function signingClient(account: string, provider: WalletProvider) {
  return createClient({
    chain: studionet,
    endpoint: STUDIONET_RPC_URL,
    account: account as `0x${string}`,
    provider,
  });
}

export async function connectWallet(): Promise<string> {
  if (!window.ethereum) {
    throw new Error("No browser wallet was found. Install Rabby or MetaMask, then return here to connect.");
  }
  const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
  const account = accounts?.[0];
  if (!account) throw new Error("Your wallet did not return an account.");
  await ensureStudionetNetwork(window.ethereum);
  return account;
}

export async function reconnectWallet(): Promise<string | null> {
  if (!window.ethereum) return null;
  const accounts = (await window.ethereum.request({ method: "eth_accounts" })) as string[];
  return accounts?.[0] ?? null;
}

export async function getDependency(dependencyId: string): Promise<DependencyView> {
  const result = await readClient().readContract({
    address: DRIFTPERMIT_ADDRESS,
    functionName: "get_dependency",
    args: [dependencyId],
  });
  return normalizeDependency(result as Record<string, unknown>);
}

export async function getPermit(dependencyId: string): Promise<PermitView> {
  const result = await readClient().readContract({
    address: DRIFTPERMIT_ADDRESS,
    functionName: "get_permit",
    args: [dependencyId],
  });
  return normalizePermit(result as Record<string, unknown>);
}

export async function isPermitValid(dependencyId: string, permitNonce: number): Promise<boolean> {
  return readClient().readContract({
    address: DRIFTPERMIT_ADDRESS,
    functionName: "is_permit_valid",
    args: [dependencyId, permitNonce],
  }) as Promise<boolean>;
}

async function write(
  account: string,
  provider: WalletProvider,
  address: `0x${string}`,
  functionName: string,
  args: unknown[],
): Promise<Hash> {
  await ensureStudionetNetwork(provider);
  return signingClient(account, provider).writeContract({
    address,
    functionName,
    args: args as CalldataEncodable[],
    value: 0n,
  }) as Promise<Hash>;
}

export function assessDependency(
  account: string,
  provider: WalletProvider,
  dependencyId: string,
): Promise<Hash> {
  return write(account, provider, DRIFTPERMIT_ADDRESS, "assess_dependency", [dependencyId]);
}

export type RegisterDependencyInput = {
  dependencyId: string;
  name: string;
  description: string;
  baselineUrl: string;
  baselineSha256: string;
  liveUrl: string;
  invariantsJson: string;
  executor: string;
  leaseSeconds: number;
};

export function registerDependency(
  account: string,
  provider: WalletProvider,
  input: RegisterDependencyInput,
): Promise<Hash> {
  return write(account, provider, DRIFTPERMIT_ADDRESS, "register_dependency", [
    input.dependencyId,
    input.name,
    input.description,
    input.baselineUrl,
    input.baselineSha256,
    input.liveUrl,
    input.invariantsJson,
    input.executor,
    input.leaseSeconds,
  ]);
}

export async function getAction(actionId: string): Promise<ActionView> {
  const result = await readClient().readContract({
    address: GUARDED_CONSUMER_ADDRESS,
    functionName: "get_action",
    args: [actionId],
  });
  return normalizeAction(result as Record<string, unknown>);
}

export function startProtectedAction(
  account: string,
  provider: WalletProvider,
  actionId: string,
  dependencyId: string,
  permitNonce: number,
  payload: string,
): Promise<Hash> {
  return write(account, provider, GUARDED_CONSUMER_ADDRESS, "start_action", [
    actionId,
    dependencyId,
    permitNonce,
    payload,
  ]);
}

export function finalizeProtectedAction(
  account: string,
  provider: WalletProvider,
  actionId: string,
): Promise<Hash> {
  return write(account, provider, GUARDED_CONSUMER_ADDRESS, "finalize_action", [actionId]);
}

export async function waitForFinalization(
  account: string,
  provider: WalletProvider,
  hash: string,
) {
  return signingClient(account, provider).waitForTransactionReceipt({
    hash: hash as Hash,
    status: TransactionStatus.FINALIZED,
    interval: 5000,
    retries: 60,
  });
}

export function transactionUrl(hash: string): string {
  return `https://explorer-studio.genlayer.com/tx/${hash}`;
}

export function contractUrl(address: string): string {
  return `https://explorer-studio.genlayer.com/address/${address}`;
}
