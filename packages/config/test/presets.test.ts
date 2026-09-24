import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readTsconfig(name: string): {
  extends?: string;
  compilerOptions?: Record<string, unknown>;
} {
  return JSON.parse(readFileSync(join(root, "tsconfig", name), "utf8")) as {
    extends?: string;
    compilerOptions?: Record<string, unknown>;
  };
}

describe("tsconfig presets", () => {
  it("base preset enforces strict type checking", () => {
    const { compilerOptions } = readTsconfig("base.json");
    expect(compilerOptions).toMatchObject({
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
    });
  });

  it.each(["node.json", "react.json"])("%s extends the strict base preset", (name) => {
    expect(readTsconfig(name).extends).toBe("./base.json");
  });
});

describe("eslint presets", () => {
  it.each([
    ["node", "../eslint/node.js"],
    ["react", "../eslint/react.js"],
  ])("%s preset builds a flat config that bans `any`", async (_name, path) => {
    const mod = (await import(path)) as Record<
      string,
      (o: { tsconfigRootDir: string }) => unknown[]
    >;
    const factory = Object.values(mod)[0];
    if (!factory) throw new Error(`no preset exported from ${path}`);
    const configs = factory({ tsconfigRootDir: root }) as { rules?: Record<string, unknown> }[];
    const noExplicitAny = configs.find((c) => c.rules?.["@typescript-eslint/no-explicit-any"]);
    expect(noExplicitAny?.rules?.["@typescript-eslint/no-explicit-any"]).toBe("error");
  });
});
