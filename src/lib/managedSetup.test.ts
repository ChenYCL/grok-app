import { describe, expect, it } from "vitest";
import {
  buildManagedSetupSteps,
  classifySetupError,
  deriveSignatureStatus,
  emptyManagedLocalStatus,
  extractPreviewMeta,
  formatRedactedJson,
  isSensitiveKey,
  redactSensitiveValue,
  summarizeSetupJson,
} from "./managedSetup";

const SAMPLE_SETUP = {
  deploymentId: "dep_abc123",
  teamId: "team_xyz",
  failClosed: true,
  managedConfig: {
    models: { default: "company-grok" },
    features: { telemetry: false },
  },
  requirements: {
    minimum_version: "0.2.0",
  },
  apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456",
  deployment_key: "deploy-secret-should-never-show",
  env: {
    OPENAI_API_KEY: "sk-nestedsecretnestedsecret",
    PATH: "/usr/bin",
  },
  headers: {
    Authorization: "Bearer supersecrettokenvalue12345",
  },
  signatures: {
    managed_config: "sig-blob-aaaaaaaaaaaaaaaa",
  },
  token: "refresh-token-should-redact",
  nested: {
    client_secret: "client-secret-value",
    name: "safe-name",
  },
};

describe("isSensitiveKey", () => {
  it("flags common secret field names", () => {
    expect(isSensitiveKey("apiKey")).toBe(true);
    expect(isSensitiveKey("api_key")).toBe(true);
    expect(isSensitiveKey("OPENAI_API_KEY")).toBe(true);
    expect(isSensitiveKey("token")).toBe(true);
    expect(isSensitiveKey("client_secret")).toBe(true);
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("deployment_key")).toBe(true);
    expect(isSensitiveKey("deploymentKey")).toBe(true);
  });

  it("allows safe field names", () => {
    expect(isSensitiveKey("name")).toBe(false);
    expect(isSensitiveKey("teamId")).toBe(false);
    expect(isSensitiveKey("deploymentId")).toBe(false);
    expect(isSensitiveKey("failClosed")).toBe(false);
    expect(isSensitiveKey("models")).toBe(false);
  });
});

describe("redactSensitiveValue", () => {
  it("redacts key-like fields and secret containers", () => {
    const safe = redactSensitiveValue(SAMPLE_SETUP) as Record<string, unknown>;
    expect(safe.apiKey).toBe("[REDACTED]");
    expect(safe.deployment_key).toBe("[REDACTED]");
    expect(safe.token).toBe("[REDACTED]");
    expect(safe.env).toBe("[REDACTED]");
    expect(safe.headers).toBe("[REDACTED]");
    expect(safe.signatures).toBe("[REDACTED]");
    expect(safe.deploymentId).toBe("dep_abc123");
    expect(safe.teamId).toBe("team_xyz");
    expect(safe.failClosed).toBe(true);

    const nested = safe.nested as Record<string, unknown>;
    expect(nested.client_secret).toBe("[REDACTED]");
    expect(nested.name).toBe("safe-name");
  });

  it("scrubs sk- tokens inside free-form strings", () => {
    const safe = redactSensitiveValue({
      note: "use sk-abcdefghijklmnopqrstuvwxyz with care",
    }) as { note: string };
    expect(safe.note).toContain("[REDACTED]");
    expect(safe.note).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });
});

describe("summarizeSetupJson", () => {
  it("builds a summary without leaking secrets", () => {
    const s = summarizeSetupJson(SAMPLE_SETUP);
    expect(s.topLevelKeys).toContain("deploymentId");
    expect(s.topLevelKeys).toContain("managedConfig");
    expect(s.facts.some((f) => f.key === "deploymentId" && f.value === "dep_abc123")).toBe(
      true,
    );
    expect(s.facts.some((f) => f.key === "failClosed" && f.value === "true")).toBe(true);
    expect(s.sectionCounts.some((c) => c.key === "managedConfig")).toBe(true);

    expect(s.redactedJson).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(s.redactedJson).not.toContain("deploy-secret-should-never-show");
    expect(s.redactedJson).not.toContain("client-secret-value");
    expect(s.redactedJson).toContain("[REDACTED]");
    expect(s.redactedJson).toContain("dep_abc123");
  });

  it("parses JSON strings and handles invalid JSON text safely", () => {
    const fromString = summarizeSetupJson(JSON.stringify(SAMPLE_SETUP));
    expect(fromString.topLevelKeys).toContain("teamId");

    const plain = summarizeSetupJson("not json but has sk-abcdefghijklmnopqr token");
    expect(plain.note).toBe("non-json");
    expect(plain.redactedJson).toContain("[REDACTED]");
    expect(plain.redactedJson).not.toContain("sk-abcdefghijklmnopqr");
  });
});

describe("formatRedactedJson", () => {
  it("never includes raw api keys", () => {
    const text = formatRedactedJson(SAMPLE_SETUP);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    expect(text).not.toContain("deploy-secret");
  });
});

describe("classifySetupError", () => {
  it("detects missing deployment key / team sign-in", () => {
    const msg = `No deployment key or team sign-in found.

To install managed configuration, sign in with a team using \`grok login\`,
or set a deployment key:

  export GROK_DEPLOYMENT_KEY=<your-key>
  grok setup`;
    expect(classifySetupError(msg)).toBe("missing_auth");
  });

  it("detects rejected key", () => {
    expect(
      classifySetupError(
        "Couldn't fetch managed configuration. The deployment key was rejected.",
      ),
    ).toBe("rejected");
  });

  it("detects signature verification failures", () => {
    expect(
      classifySetupError("managed config signature rejected; not persisting"),
    ).toBe("signature_rejected");
    expect(
      classifySetupError(
        "Managed policy is required but could not be verified from the server.",
      ),
    ).toBe("signature_rejected");
    expect(classifySetupError("is-managed claim did not verify")).toBe(
      "signature_rejected",
    );
  });

  it("detects cli missing and timeout", () => {
    expect(classifySetupError("Grok Build CLI not found")).toBe("cli_missing");
    expect(classifySetupError("grok command timed out after 30s")).toBe("timeout");
  });
});

describe("extractPreviewMeta", () => {
  it("reads safe ids and signature presence without secrets", () => {
    const meta = extractPreviewMeta(SAMPLE_SETUP);
    expect(meta.deploymentId).toBe("dep_abc123");
    expect(meta.teamId).toBe("team_xyz");
    expect(meta.failClosed).toBe(true);
    expect(meta.hasSignatureBlock).toBe(true);
    expect(meta.hasRequirements).toBe(true);
  });

  it("handles empty / non-json safely", () => {
    expect(extractPreviewMeta(null).deploymentId).toBeNull();
    expect(extractPreviewMeta("not json").hasSignatureBlock).toBe(false);
  });
});

describe("deriveSignatureStatus", () => {
  it("prefers active managed settings from inspect", () => {
    expect(
      deriveSignatureStatus({
        local: emptyManagedLocalStatus({ managedSettingsActive: true }),
      }),
    ).toBe("active");
  });

  it("surfaces signature files and artifacts honestly", () => {
    expect(
      deriveSignatureStatus({
        local: emptyManagedLocalStatus({ configSignaturePresent: true }),
      }),
    ).toBe("sig_files");
    expect(
      deriveSignatureStatus({
        local: emptyManagedLocalStatus({ managedConfigPresent: true }),
      }),
    ).toBe("artifacts");
    expect(deriveSignatureStatus({ local: emptyManagedLocalStatus() })).toBe(
      "none",
    );
    expect(deriveSignatureStatus({})).toBe("unknown");
  });

  it("marks signature_rejected errors", () => {
    expect(
      deriveSignatureStatus({ errorKind: "signature_rejected" }),
    ).toBe("rejected");
  });
});

describe("buildManagedSetupSteps", () => {
  it("blocks on missing CLI and advances after install", () => {
    const noCli = buildManagedSetupSteps({ cliFound: false });
    expect(noCli.find((s) => s.id === "cli")?.state).toBe("blocked");

    const ready = buildManagedSetupSteps({
      cliFound: true,
      previewDone: true,
      installDone: true,
      local: emptyManagedLocalStatus({
        managedConfigPresent: true,
        configSignaturePresent: true,
        managedSettingsActive: true,
      }),
      signatureStatus: "active",
    });
    expect(ready.find((s) => s.id === "cli")?.state).toBe("done");
    expect(ready.find((s) => s.id === "install")?.state).toBe("done");
    expect(ready.find((s) => s.id === "verify")?.state).toBe("done");
  });

  it("marks auth blocked on missing deployment key", () => {
    const steps = buildManagedSetupSteps({
      cliFound: true,
      errorKind: "missing_auth",
    });
    expect(steps.find((s) => s.id === "auth")?.state).toBe("blocked");
  });
});
