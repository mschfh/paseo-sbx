import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogClaudeSettings, catalogStatus, ensureCatalog } from "../server/catalog";
import { daemonPort } from "../server/daemon";
import { installBinFiles, opencodeRuntimeDir, pluginPaths } from "../server/paths";
import { sandboxSettingsSchema } from "../shared/settings";
import { catalogName } from "../shared/spec";
import { installFakeSbx } from "./fake-sbx";

let root: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "paseo-sbx-catalog-")));
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});

describe("catalog", () => {
  it("keeps the gateway's token and any key helper out of the catalog's Claude settings", () => {
    expect(
      catalogClaudeSettings({ env: { ANTHROPIC_AUTH_TOKEN: "t" }, apiKeyHelper: "pass", model: "opus", permissions: { allow: [] } }),
    ).toEqual({ model: "opus", permissions: { allow: [] } });
    expect(catalogClaudeSettings(null)).toEqual({});
  });

  it("names each instance's catalog apart, since sbx keeps policies per name for every instance", () => {
    expect(catalogName("codex", "/a/sbx")).toMatch(/^paseo-catalog-codex-[0-9a-f]{8}$/);
    expect(catalogName("codex", "/a/sbx")).not.toBe(catalogName("codex", "/b/sbx"));
  });

  it("sets up OpenCode's catalog with its runtime mount, shared XDG_DATA_HOME, and multi-provider secret check", async () => {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const fake = installFakeSbx(root);
    writeFileSync(join(fake.bin, "opencode"), "#!/bin/sh\n[ \"$1\" = --version ] && echo 2.1.3\nexit 0\n");
    chmodSync(join(fake.bin, "opencode"), 0o755);
    Object.assign(process.env, fake.env);
    process.env.PASEO_HOME = join(root, "paseo");
    const paths = pluginPaths({ XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(home, ".config") }, home);
    installBinFiles(paths);
    fake.setState({ sandboxes: [] });
    const settings = sandboxSettingsSchema.parse({ enabledAgents: ["claude", "opencode"], allowImageDownloads: true });

    const record = await ensureCatalog(paths, settings, "opencode", { update: false });
    expect(record.cliVersion).toBe("2.1.3");
    expect(record.agentHome).toEqual({ env: "XDG_DATA_HOME", path: join(paths.homesDir, "opencode") });
    const create = fake.calls().find((call) => call.args[0] === "create");
    const runtimeDir = opencodeRuntimeDir(process.env);
    expect(existsSync(runtimeDir)).toBe(true);
    expect(create?.args).toContain(`${runtimeDir}:ro`);
    expect(create?.args).toContain("docker.io/docker/sbx-kit-opencode:latest");

    // Stored secrets: any of OpenCode's supported provider services marks login.stored true.
    fake.setState({
      sandboxes: [record.name],
      serviceSecrets: [
        { scope: "global", type: "service", name: "openrouter" },
        { scope: "global", type: "service", name: "anthropic" },
      ],
    });
    const status = await catalogStatus(paths, "opencode");
    expect(status.exists).toBe(true);
    expect(status.login).toEqual({ service: "anthropic", stored: true, services: ["anthropic", "openrouter"] });
  });
});

describe("daemonPort", () => {
  function withConfig(listen: unknown) {
    mkdirSync(join(root, "paseo"), { recursive: true });
    writeFileSync(join(root, "paseo", "config.json"), JSON.stringify({ daemon: { listen } }));
    return daemonPort({ PASEO_HOME: join(root, "paseo") }, root);
  }

  it("reads the port the daemon listens on", () => {
    expect(withConfig("0.0.0.0:6790")).toBe(6790);
    expect(withConfig("7000")).toBe(7000);
  });

  it("has no port for a unix socket, and Paseo's default without a config", () => {
    expect(withConfig("/run/paseo.sock")).toBeNull();
    expect(daemonPort({ PASEO_HOME: join(root, "missing") }, root)).toBe(6767);
  });
});
