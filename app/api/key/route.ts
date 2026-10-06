import { ballotPublicKey } from "@/lib/server/ballots";
import { handleError, json } from "@/lib/server/http";

/** Public half of the ballot key. Browsers seal votes, trust and picks to it. */
export async function GET() {
  try {
    return json({ key: ballotPublicKey() });
  } catch (e) {
    return handleError(e);
  }
}
