/**
 * Window chrome: Overlay + hiddenTitle gives frameless content with mac traffic lights.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CONF_PATH = resolve(__dirname, "../../src-tauri/tauri.conf.json");

describe("window chrome", () => {
  it("uses Overlay titlebar for mac traffic lights without system title text", () => {
    const conf = JSON.parse(readFileSync(CONF_PATH, "utf8")) as {
      productName?: string;
      app: {
        macOSPrivateApi?: boolean;
        windows: Array<{
          title?: string;
          decorations?: boolean;
          titleBarStyle?: string;
          hiddenTitle?: boolean;
          trafficLightPosition?: { x: number; y: number };
          transparent?: boolean;
        }>;
      };
    };
    const main = conf.app.windows[0]!;
    expect(conf.productName).toBe("Grok");
    expect(main.title).toBe("Grok");
    expect(main.titleBarStyle).toBe("Overlay");
    expect(main.hiddenTitle).toBe(true);
    expect(main.trafficLightPosition).toBeTruthy();
    // Transparent window for glass sidebar; main pane is solid CSS
    expect(main.transparent).toBe(true);
    expect(conf.app.macOSPrivateApi).toBe(true);
  });

  it("uses window-vibrancy for native frosted glass on macOS", () => {
    const cargo = readFileSync(
      resolve(__dirname, "../../src-tauri/Cargo.toml"),
      "utf8",
    );
    expect(cargo).toMatch(/window-vibrancy/);
  });
});
