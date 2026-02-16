/**
 * Create a new version tag based on conventional commit types
 *
 * Resources:
 *  * https://forgejo.org/docs/latest/user/actions/reference/#steps has
 *  * https://github.com/actions/toolkit/blob/main/packages/core/src/core.ts
 *  * https://github.com/actions/toolkit/blob/main/packages/core/src/file-command.ts#L27
 */
import {readFile, appendFile} from 'node:fs/promises';
import os from 'node:os';

async function main() {
  const client = new ApiClient(
    process.env['GITHUB_API_URL'],
    process.env['GITHUB_REPOSITORY'],
    process.env['INPUT_TOKEN'],
  );

  const [messages, oldVersion] = await Promise.all([
    readCommitMessages(process.env['GITHUB_EVENT_PATH']),
    client.fetchLatestTaggedVersion(),
  ]);
  const customBumps = parseCustomBumps(process.env['INPUT_CUSTOM-BUMPS']);

  const bump = deriveVersionBump(messages, customBumps);
  const newVersion = bumpVersion(oldVersion, bump);
  const tag = formatStableVersion(newVersion, 'v');
  await client.createVersionTag(tag, process.env['GITHUB_SHA']);

  await setOutput('old-version', formatStableVersion(oldVersion));
  await setOutput('new-version', formatStableVersion(newVersion));
  await setOutput('tag', tag);

  console.log(`Created tag ${tag}.`);
}

const linePattern = /\r?\n/;

export function parseCustomBumps(input) {
  const tups = [];
  for (const line of input.split(linePattern)) {
    const trimmed = line.trim();
    if (!line) {
      continue;
    }
    const i = trimmed.indexOf(' ');
    if (i < 0) {
      throw new Error(`Unable to parse custom bump definition: ${trimmed}`);
    }
    const bump = bumps[trimmed.slice(0, i).toUpperCase()];
    if (!bump) {
      throw new Error(`Invalid bump definition: ${trimmed}`);
    }
    tups.push([bump, new RegExp(trimmed.slice(i+1).trim())]);
  }
  console.log(`Loaded ${tups.length} custom bump(s).`);
  return tups;
}

const TAGS_LIMIT = 10;

export class ApiClient {
  constructor(url, repo, token) {
    this.url = url;
    this.repo = repo;
    this.token = token;
  }

  async fetchLatestTaggedVersion() {
    const params = new URLSearchParams();
    params.append('limit', TAGS_LIMIT);
    const res = await fetch(`${this.url}/repos/${this.repo}/tags?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + this.token,
      },
    });
    if (!res.ok) {
      throw new Error(`Unable to fetch tags: API status ${res.status}`);
    }
    const tags = await res.json();
    for (const tag of tags) {
      const version = parseVersionTag(tag.name);
      if (version) {
        console.log(`Retrieved latest version tag: ${JSON.stringify(tag)}`);
        return version;
      }
    }
    return {major: 0, minor: 0, patch: 0};
  }

  async createVersionTag(s, sha) {
    console.log(`Creating tag ${s} on ${sha}.`);
    let url, body;
    if (isGitHub()) {
      // GitHub: create a lightweight tag via the git refs API.
      url = `${this.url}/repos/${this.repo}/git/refs`;
      body = {ref: 'refs/tags/' + s, sha};
    } else {
      // Forgejo: create a tag via the tags API.
      url = `${this.url}/repos/${this.repo}/tags`;
      body = {tag_name: s, target: sha};
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + this.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Unable to create tag: API status ${res.status}`);
    }
  }
}

/** Extract commit messages from the action's event's path */
async function readCommitMessages(p) {
  const str = await readFile(p, 'utf8');
  const data = JSON.parse(str);
  console.log(`Reading commit messages from ${data.action} event.`);
  switch (data.action) {
    case 'opened':
    case 'synchronized':
      return [data.pull_request.title];
    default: // TODO: Add explicit name for this case
      return data.commits.map((c) => c.message);
  }
}

/**
 * Semver regex, prefixed with v. See
 * https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
 * for the source.
 */
const versionTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function parseVersionTag(s) {
  const match = versionTagPattern.exec(s);
  if (!match) {
    return undefined;
  }
  const [_all, major, minor, patch, release, build] = match;
  return {major: +major, minor: +minor, patch: +patch, release, build};
}

function formatStableVersion(v, prefix='') {
  if (v.release || v.build) {
    throw new Error(`Unstable version: ${JSON.stringify(v)}`);
  }
  return `${prefix}${v.major}.${v.minor}.${v.patch}`;
}

export const bumps = {MAJOR: 3, MINOR: 2, PATCH: 1};

const commitTypePattern = /^([a-z]+)(\([^)]+\))?(!)?:.*/;

export function deriveVersionBump(messages, customBumps) {
  let maxBump = 0;
  for (const m of messages) {
    const title = m.split('\n', 1);
    const match = commitTypePattern.exec(title);
    let bump;
    if (match) {
      const [_all, type, _scope, breaking] = match;
      bump = breaking
        ? bumps.MAJOR
        : type === 'feat' ? bumps.MINOR : bumps.PATCH;
    } else {
      for (const [b, p] of customBumps) {
        if (p.test(title)) {
          bump = b;
          break;
        }
      }
      if (!bump) {
        throw new Error(`Unparseable title: ${title}`);
      }
    }
    maxBump = Math.max(bump, maxBump);
  }
  return maxBump;
}

function bumpVersion(v, b) {
  switch (b) {
    case bumps.MAJOR: return {major: v.major+1, minor: 0, patch: 0};
    case bumps.MINOR: return {major: v.major, minor: v.minor+1, patch: 0};
    case bumps.PATCH: return {major: v.major, minor: v.minor, patch: v.patch+1};
    default: throw new Error(`Invalid bump: ${b}`);
  }
}

async function setOutput(n, v) { // Single line only for now
  const path = process.env['GITHUB_OUTPUT'];
  if (!path) {
    throw new Error('Missing output path');
  }
  if (n.includes(os.EOL) || v.includes(os.EOL)) {
    // https://forgejo.org/docs/latest/user/actions/reference/#steps has
    // instructions for supporting newlines.
    throw new Error('New lines are not supported yet');
  }
  await appendFile(path, `${n}=${v}${os.EOL}`, 'utf8');
}

function isGitHub() {
  return !process.env['FORGEJO_API_URL'];
}

if (isGitHub() || import.meta.main) {
  await main();
}
