import { describe, expect, it } from "vitest";
import { electHost } from "@/lib/game/host";

describe("host election", () => {
  const members = [
    { uid: "p-cccccccccccc", joinedAt: 300, online: true },
    { uid: "p-aaaaaaaaaaaa", joinedAt: 100, online: true },
    { uid: "p-bbbbbbbbbbbb", joinedAt: 200, online: true },
    { uid: "p-botbotbotbot", joinedAt: 50, online: false }, // pooled bot: never online
  ];

  it("picks the oldest online member", () => {
    expect(electHost(members)).toBe("p-aaaaaaaaaaaa");
  });

  it("hands off to the next oldest human when the host leaves", () => {
    const left = members.map((m) => (m.uid === "p-aaaaaaaaaaaa" ? { ...m, online: false } : m));
    expect(electHost(left)).toBe("p-bbbbbbbbbbbb");
  });

  it("is independent of client ordering", () => {
    const shuffled = [members[2], members[3], members[0], members[1]];
    expect(electHost(shuffled)).toBe(electHost(members));
  });

  it("breaks joinedAt ties by uid", () => {
    expect(
      electHost([
        { uid: "p-zzzzzzzzzzzz", joinedAt: 1, online: true },
        { uid: "p-mmmmmmmmmmmm", joinedAt: 1, online: true },
      ]),
    ).toBe("p-mmmmmmmmmmmm");
  });

  it("returns null when nobody is online", () => {
    expect(electHost(members.map((m) => ({ ...m, online: false })))).toBeNull();
  });
});
