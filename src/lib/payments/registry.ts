import type { PaymentProvider } from "./provider";
import { sadapayProvider } from "./sadapay";
import { jazzcashProvider } from "./jazzcash";
import { easypaisaProvider } from "./easypaisa";

/**
 * The single place that decides whether a real gateway can be trusted yet.
 *
 * Every provider is listed with its required environment variables so the app can
 * tell the truth on screen ("SadaPay webhooks: not configured") instead of offering
 * a button that fails at the last step.
 */

export const PROVIDERS: PaymentProvider[] = [sadapayProvider, jazzcashProvider, easypaisaProvider];

export function loadProvider(name: string): PaymentProvider | null {
  const wanted = (name ?? "").trim().toLowerCase();
  return PROVIDERS.find((provider) => provider.name === wanted) ?? null;
}

export type ProviderStatus = { name: string; configured: boolean; requiredEnv: string[] };

export function providerStatuses(): ProviderStatus[] {
  return PROVIDERS.map((provider) => ({
    name: provider.name,
    configured: provider.isConfigured(),
    requiredEnv: provider.requiredEnv,
  }));
}

/** True when at least one real gateway is live — used by the billing page copy. */
export function anyProviderConfigured(): boolean {
  return PROVIDERS.some((provider) => provider.isConfigured());
}
