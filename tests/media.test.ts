import { existsSync, readFileSync, rmSync } from "fs";
import { extname } from "path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  dialog: {
    showSaveDialog: vi.fn(),
  },
}));

import { materializeDataUrlToTemp } from "../src/main/media";

describe("materializeDataUrlToTemp", () => {
  it("writes a data URL to a temporary image file that can be opened", () => {
    const path = materializeDataUrlToTemp(
      "data:image/png;base64,SGVybWVz",
      "prompt-image",
    );

    expect(path).toBeTruthy();
    expect(extname(path || "")).toBe(".png");
    expect(existsSync(path || "")).toBe(true);
    expect(readFileSync(path || "", "utf-8")).toBe("Hermes");

    if (path) rmSync(path, { force: true });
  });
});
