import { expect, it } from "vitest";
import { roomFromPath, roomPath } from "../apps/web/src/routes";
import { ancestors, command } from "@geochalk/shared";

it("round-trips room navigation at every level through underscore URLs", () => {
  for (const room of [...ancestors("9q8yyk8y"), "qr"]) {
    const path = roomPath(room);
    expect(roomFromPath(path)).toBe(room);
    expect(roomFromPath(path + "/")).toBe(room);
  }
  expect(roomPath("_")).toBe("/_");
  expect(roomPath("9q8yu")).toBe("/_9q8yu");
  expect(roomPath("qr")).toBe("/_qr");
  const out = command("/out", roomFromPath("/_q"));
  expect(out).toEqual({ kind: "go", room: "_" });
  if (out?.kind === "go") expect(roomPath(out.room)).toBe("/_");
});

it("does not interpret other pages or malformed URLs as rooms", () => {
  for (const path of [
    "/",
    "/qr",
    "/about",
    "/9q8yu",
    "/g/9q8yu",
    "/api/rooms/_/messages",
    "/__",
    "/_a",
    "/_QR",
    "/_9q8yyk8yy",
    "/_9q8yu/extra",
    "/_9q8yu//",
  ])
    expect(roomFromPath(path)).toBe("");
  for (const room of ["", "_qr", "a", "9q8yyk8yy", "../about"])
    expect(() => roomPath(room)).toThrow();
});
