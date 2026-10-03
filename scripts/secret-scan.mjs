#!/usr/bin/env node
// Scans the whole git history (every commit on every ref) and the current working tree
// (tracked + staged files) for credentials. Dependency-free on purpose: it runs on a dev
// machine with only Node + pnpm. CI additionally runs gitleaks (see .github/workflows/ci.yml).
//
//   node scripts/secret-scan.mjs            # history + working tree
//   node scripts/secret-scan.mjs --tree     # working tree only (fast; used by CI on PRs)
//
// Exit code 1 when anything is found. Matches are printed with the secret masked.

import { execFileSync } from "node:child_process";

const RULES = [
  { name: "Anthropic API key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "Razorpay live key id", pattern: /rzp_live_[A-Za-z0-9]{10,}/g },
  { name: "Resend API key", pattern: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/g },
  { name: "Supabase secret key", pattern: /\bsb_secret_[A-Za-z0-9_-]{20,}/g },
  // Supabase legacy keys are JWTs; the anon key is public but the service_role key is not.
  {
    name: "JWT (check the role claim)",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    name: "Private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: "GitHub token",
    pattern: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/g,
  },
  { name: "Sentry auth token", pattern: /\bsntrys_[A-Za-z0-9+/=_-]{40,}/g },
  // A connection string with a real-looking password (placeholders are allowlisted below).
  {
    name: "Database URL with password",
    pattern: /postgres(?:ql)?:\/\/[^:\s/"'`]+:[^@\s"'`]{8,}@[^\s"'`]+/g,
  },
  // KEY=value assignments of secret-named variables (e.g. a pasted .env).
  {
    name: "Secret env assignment",
    pattern:
      /\b[A-Z_]*(?:SECRET|PASSWORD|SERVICE_ROLE_KEY|API_KEY|AUTH_TOKEN)[A-Z_]*\s*=\s*["']?[A-Za-z0-9+/_.=-]{16,}/g,
  },
];

// Known non-secrets: documentation placeholders and deterministic test values.
// Test fixtures in this repo follow one convention: fake secrets contain "0123456789" (a real
// random key essentially never does), so real keys pasted into test files are still caught.
const ALLOW = [
  /0123456789/,
  /postgres(?:ql)?:\/\/postgres:postgres@/,
  /postgres(?:ql)?:\/\/postgres:s3cret-password@127\.0\.0\.1/, // env validation test
  /postgres(?:ql)?:\/\/[^:]+:(?:password|PASSWORD|\[YOUR-PASSWORD\]|<password>|your-password|\$\{?[A-Z_]+\}?)@/,
  /=\s*["']?(?:x{16,}|changeme|replace-me|<[^>]+>)/i,
  /=\s*["']?\$\{\{\s*secrets\./, // GitHub Actions references
  /=\s*["']?\$[A-Z_]+/, // shell variable references
  /(?:SECRET|TOKEN|KEY)[A-Z_]*\s*=\s*["']?(?:test|e2e|dev|local)[-_a-z0-9]*["']?$/i,
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
}

function mask(secret) {
  return secret.length <= 12
    ? "****"
    : `${secret.slice(0, 8)}…${secret.slice(-4)} (${secret.length} chars)`;
}

function jwtRole(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

function scanText(text, where, findings) {
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const rule of RULES) {
      for (const match of line.matchAll(rule.pattern)) {
        if (ALLOW.some((allow) => allow.test(line))) continue;
        // Public JWTs (Supabase anon/publishable) are expected in web env examples.
        if (rule.name.startsWith("JWT") && jwtRole(match[0]) === "anon") continue;
        findings.push({ rule: rule.name, where: where(index), secret: mask(match[0]) });
      }
    }
  }
}

const findings = [];
const treeOnly = process.argv.includes("--tree");

// Working tree: every tracked or staged file (untracked files are ignored; .env is gitignored).
for (const file of git(["ls-files", "--cached"]).split("\n").filter(Boolean)) {
  if (/(?:^|\/)pnpm-lock\.yaml$|\.(?:png|jpg|jpeg|gif|webp|woff2?|ico|zip|pdf)$/.test(file))
    continue;
  let text;
  try {
    text = git(["show", `:${file}`]);
  } catch {
    continue;
  }
  scanText(text, (i) => `${file}:${i + 1} (index)`, findings);
}

if (!treeOnly) {
  // History: only added lines of every commit, so a secret removed later is still found.
  const log = git(["log", "--all", "-p", "--no-color", "--unified=0", "--format=@@commit %H"]);
  let commit = "";
  let file = "";
  const added = [];
  for (const line of log.split("\n")) {
    if (line.startsWith("@@commit ")) commit = line.slice(9, 17);
    else if (line.startsWith("+++ b/")) file = line.slice(6);
    else if (line.startsWith("+") && !line.startsWith("+++"))
      added.push({ commit, file, text: line.slice(1) });
  }
  for (const entry of added) {
    if (/pnpm-lock\.yaml$/.test(entry.file)) continue;
    scanText(entry.text, () => `${entry.file} (commit ${entry.commit})`, findings);
  }
}

const unique = [...new Map(findings.map((f) => [`${f.rule}|${f.where}|${f.secret}`, f])).values()];
if (unique.length === 0) {
  process.stdout.write(
    `secret scan: nothing found (${treeOnly ? "working tree" : "full history + working tree"})\n`,
  );
} else {
  for (const f of unique) process.stdout.write(`${f.rule}: ${f.where}: ${f.secret}\n`);
  process.stdout.write(`secret scan: ${unique.length} finding(s)\n`);
  process.exitCode = 1;
}
