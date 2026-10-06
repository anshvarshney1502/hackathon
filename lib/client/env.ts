/** Only NEXT_PUBLIC_* values may be read in the browser. They are inlined at build time. */
export type PublicEnv =
  | { ok: true; appId: string; region: "us" | "eu" | "in" }
  | { ok: false; missing: string[] };

export function publicEnv(): PublicEnv {
  const appId = process.env.NEXT_PUBLIC_COMETCHAT_APP_ID ?? "";
  const region = process.env.NEXT_PUBLIC_COMETCHAT_REGION ?? "";
  const missing: string[] = [];
  if (!appId) missing.push("NEXT_PUBLIC_COMETCHAT_APP_ID");
  if (region !== "us" && region !== "eu" && region !== "in") missing.push("NEXT_PUBLIC_COMETCHAT_REGION");
  return missing.length ? { ok: false, missing } : { ok: true, appId, region: region as "us" | "eu" | "in" };
}
