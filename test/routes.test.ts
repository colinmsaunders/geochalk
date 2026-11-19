import { expect, it } from "vitest";
import { roomFromPath, roomPath } from "../apps/web/src/routes";
import { ancestors, command } from "@geochalk/shared";

it("round-trips room navigation at every level through @ URLs", () => {
  for (const room of [...ancestors("9q8yyk8y"), "qr"]) {
    const path = roomPath(room);
    expect(roomFromPath(path)).toBe(room);
    expect(roomFromPath(path + "/")).toBe(room);
  }
  expect(roomPath("_")).toBe("/@");
  expect(roomPath("9q8yu")).toBe("/@9q8yu");
  expect(roomPath("qr")).toBe("/@qr");
  const out = command("/out", roomFromPath("/@q"));
  expect(out).toEqual({ kind: "go", room: "_" });
  if (out?.kind === "go") expect(roomPath(out.room)).toBe("/@");
});

it("does not interpret other pages or malformed URLs as rooms", () => {
  for (const path of [
    "/",
    "/qr",
    "/about",
    "/9q8yu",
    "/g/9q8yu",
    "/api/rooms/_/messages",
    "/@_",
    "/@a",
    "/@QR",
    "/@9q8yyk8yy",
    "/@9q8yu/extra",
    "/@9q8yu//",
  ])
    expect(roomFromPath(path)).toBe("");
  for (const room of ["", "_qr", "a", "9q8yyk8yy", "../about"])
    expect(() => roomPath(room)).toThrow();
});
