export const TOPICS = [
  "Worst food you've eaten at a wedding",
  "Defend your most controversial opinion",
  "What is a completely useless skill you have?",
  "What would you never spend money on?",
  "The most overrated thing everyone pretends to love",
  "A small lie you tell all the time",
  "Your most irrational fear",
  "Worst job or internship you ever had",
  "Something you were weirdly late to discover",
  "The pettiest reason you stopped talking to someone",
  "Best thing to eat at 2am",
  "A hill you will die on about chai or coffee",
  "The worst gift you ever received",
  "What gets you instantly annoyed on public transport",
  "Your most embarrassing autocorrect or wrong-chat moment",
  "Rate your city's weather, honestly",
  "What would you do with one extra hour every day?",
  "A movie everyone loves that you can't stand",
  "Group projects: villain origin story",
  "The strangest thing in your phone's camera roll",
] as const;

/** Rotates through a room-specific shuffle so topics don't repeat for ~20 rounds. */
export function topicForRound(roomId: string, round: number): string {
  let seed = 0;
  for (const ch of roomId) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const order = TOPICS.map((t, i) => ({ t, k: ((i + 1) * 2654435761 + seed) >>> 0 })).sort((a, b) => a.k - b.k);
  return order[(round - 1 + order.length) % order.length].t;
}
