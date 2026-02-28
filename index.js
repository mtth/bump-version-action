import {readFile, appendFile} from 'node:fs/promises';
import os from 'node:os';

async function main() {
  const client = new ApiClient(
    process.env['GITHUB_API_URL'],
    process.env['GITHUB_REPOSITORY'],
    process.env['INPUT_TOKEN'],
  );

  const filter = parsePrefixFilter(process.env['INPUT_PREFIX-FILTER']);
  const [change, latest] = await Promise.all([
    readChange(process.env['GITHUB_EVENT_PATH']),
    client.fetchLatestTaggedVersion(filter),
  ]);
  const oldVersion = latest.version;
  const rules = loadRules(process.env['INPUT_RULES']);
  const ignoreBreaking = parseBoolean(
    process.env['INPUT_IGNORE-BREAKING'] || (oldVersion.major ? '0' : '1')
  );

  await setOutput('old-version', oldVersion.toString(''));

  const bump = deriveVersionBump(change.messages, rules, ignoreBreaking);
  if (bump.level === bumpLevels.NOOP) {
    console.log(`No bump needed, skipping tag creation.`);
    return
  }

  let newVersion;
  if (latest.isNext) {
    console.log(`Prefix filter does not match any versions, overriding bump.`);
    newVersion = filter.version;
  } else {
    newVersion = bumpVersion(oldVersion, bump);
  }
  if (filter && !matchesPrefix(newVersion, filter)) {
    throw new Error(`Bump leaves prefix ${filter.prefix}: ${newVersion}`);
  }
  await setOutput('new-version', newVersion.toString(''));

  const tag = newVersion.toString();
  if (change.isPR) {
    console.log(`PR detected, skipping creation of tag ${tag}.`);
  } else {
    await client.createVersionTag(tag, process.env['GITHUB_SHA']);
    await setOutput('tag', tag);
    console.log(`Created tag ${tag}.`);
  }
}

const linePattern = /\r?\n/;

export class ApiClient {
  constructor(url, repo, token) {
    this.url = url;
    this.repo = repo;
    this.token = token;
  }

  async fetchLatestTaggedVersion(filter) {
    const refs = await this.fetchTagRefs(filter);
    const versions = refs
      .map((o) => Version.parseRef(o.ref))
      .filter((v) => !!v)
      .sort((v1, v2) => Version.compare(v2, v1));
    console.log(`Fetched ${versions.length} versions (${refs.length} refs).`);
    const latest = versions[0];
    if (latest) {
      console.log(`Using latest version tag: ${latest}`);
      return {version: latest, isNext: false};
    }
    const fallback = filter?.version ?? new Version(0, 0, 0);
    console.log(`No version tag found, assuming version ${fallback}.`);
    return {version: fallback, isNext: !!filter};
  }

  async fetchTagRefs(filter) {
    let url;
    const ref = tagRefPrefix(filter);
    if (isGitHub()) {
      url = `${this.url}/repos/${this.repo}/git/matching-refs/${ref}`;
    } else {
      url = `${this.url}/repos/${this.repo}/git/refs/${ref}`;
    }
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + this.token,
      },
    });
    if (res.status === 404) { // Forgejo will return 404 on no match.
      return [];
    }
    if (!res.ok) {
      throw new Error(`Unable to fetch tag refs: API status ${res.status}`);
    }
    return await res.json();
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
async function readChange(p) {
  console.log(`Reading commit messages from event.`);
  const str = await readFile(p, 'utf8');
  const data = JSON.parse(str);
  switch (data.action) {
    case 'opened':
    case 'synchronize': // GitHub
    case 'synchronized': // Forgejo
      // Support pull request for easier debugging.
      return {isPR: true, messages: [data.pull_request.title]};
    default:
      // Push to branch, etc.
      return {isPR: false, messages: data.commits.map((c) => c.message)};
  }
}

/**
 * Semver regex, prefixed with v. See
 * https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
 * for the source.
 */
const versionTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const tagRefPattern = /^refs\/tags\//;

export class Version {
  constructor(major, minor, patch, release) {
    this.major = major;
    this.minor = minor;
    this.patch = patch;
    this.release = release;
  }

  static parseTag(s) {
    const match = versionTagPattern.exec(s);
    if (!match) {
      return undefined;
    }
    const [_all, major, minor, patch, rel, build] = match;
    const parsed = parseRelease(rel);
    if ((rel && !parsed) || build) {
      console.warn(`Skipping unsupported version tag: ${s}`);
      return undefined;
    }
    return new Version(+major, +minor, +patch, parsed);
  }

  static parseRef(ref) {
    if (!tagRefPattern.test(ref)) {
      return undefined;
    }
    return Version.parseTag(ref.replace(tagRefPattern, ''));
  }

  toString(prefix='v') {
    const rel = this.release ? `-${this.release[0]}.${this.release[1]}` : '';
    return `${prefix}${this.major}.${this.minor}.${this.patch}${rel}`;
  }

  static compare(v1, v2) {
    if (v1.major !== v2.major) {
      return v1.major - v2.major;
    }
    if (v1.minor !== v2.minor) {
      return v1.minor - v2.minor;
    }
    if (v1.patch !== v2.patch) {
      return v1.patch - v2.patch;
    }
    const rel1 = v1.release;
    const rel2 = v2.release;
    if (!rel1 && !rel2) {
      return 0;
    }
    if (!rel1) {
      return 1;
    }
    if (!rel2) {
      return -1;
    }
    const [label1, num1] = rel1;
    const [label2, num2] = rel2;
    return label1.localeCompare(label2) || (num1 - num2);
  }

  stable() {
    return new Version(this.major, this.minor, this.patch);
  }

  bump(level) {
    switch (level) {
      case bumpLevels.MAJOR: {
        const keep = this.release && this.minor === 0 && this.patch === 0;
        const major = this.major + (keep ? 0 : 1);
        return new Version(major, 0, 0);
      }
      case bumpLevels.MINOR: {
        const keep = this.release && this.patch === 0;
        const minor = this.minor + (keep ? 0 : 1);
        return new Version(this.major, minor, 0);
      }
      case bumpLevels.PATCH: {
        const patch = this.patch + (this.release ? 0 : 1);
        return new Version(this.major, this.minor, patch);
      }
      default:
        throw new Error(`Invalid stable bump level: ${level}`);
    }
  }
}

const releasePattern = /^([^.]+)\.(\d+)$/;

function parseRelease(release) {
  const match = releasePattern.exec(release);
  if (!match) {
    return undefined;
  }
  const [_all, label, num] = match;
  return [label, +num];
}

export const bumpLevels = {MAJOR: 3, MINOR: 2, PATCH: 1, NOOP: 0};

const stableBumps = {
  major: {kind: 'major', level: bumpLevels.MAJOR},
  minor: {kind: 'minor', level: bumpLevels.MINOR},
  patch: {kind: 'patch', level: bumpLevels.PATCH},
  noop: {kind: 'noop', level: bumpLevels.NOOP},
};

const bumpPattern = /^([^:]+)(?::(\S+))?$/;

export function parseBumpDefinition(input) {
  const match = bumpPattern.exec(input.trim());
  if (match) {
    const [_all, kind, release] = match;
    switch (kind) {
      case 'major':
      case 'minor':
      case 'patch':
      case 'noop':
        if (release == null) {
          return stableBumps[kind];
        }
        break;
      case 'premajor':
      case 'preminor':
      case 'prepatch':
        if (release) {
          return {...stableBumps[kind.slice(3)], kind, release};
        }
    }
  }
  throw new Error(`Invalid bump definition: ${input}`);
}

export class Rule {
  constructor(kind, bump, pattern) {
    this.kind = kind;
    this.bump = bump;
    this.pattern = pattern;
  }

  static parse(line) {
    const trimmed = line.trim();
    const parts = trimmed.split(/\s+/, 3);
    if (parts.length < 3) {
      throw new Error(`Unable to parse rule: ${line}`);
    }
    const [bumpName, kind, pattern] = parts;
    if (kind !== 'title' && kind !== 'type') {
      throw new Error(`Invalid rule kind: ${kind}`);
    }
    const bump = parseBumpDefinition(bumpName);
    return new Rule(kind, bump, new RegExp(pattern));
  }
}

export function loadRules(input) {
  const rules = [];
  const value = input ?? '';
  for (const line of value.split(linePattern)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    rules.push(Rule.parse(trimmed));
  }
  console.log(`Loaded ${rules.length} rule(s).`);
  return rules;
}

const commitTypePattern = /^([a-z]+)(\([^)]+\))?(!)?:.*/;

export function deriveVersionBump(messages, rules, ignoreBreaking=false) {
  console.log(`Deriving bump from ${messages.length} commit message(s).`);
  let maxBump = stableBumps.noop;
  for (const m of messages) {
    const title = m.split('\n', 1)[0];
    const match = commitTypePattern.exec(title);
    let bump;
    for (const rule of rules) {
      switch (rule.kind) {
        case 'title':
          if (rule.pattern.test(title)) {
            bump = rule.bump;
          }
          break;
        case 'type':
          if (!match) {
            break;
          }
          const [_all, type, _scope, breaking] = match;
          if (rule.pattern.test(type)) {
            bump = (!ignoreBreaking && breaking) ? stableBumps.major : rule.bump;
          }
          break;
        default:
          throw new Error(`Unexpected rule kind: ${rule.kind}`);
      }
      if (bump != null) {
        break;
      }
    }
    if (bump == null) {
      throw new Error(`Unmatched title: ${title}`);
    }
    console.log(`\t${bump.kind}\t${title}`);
    if (bump.level > maxBump.level) {
      maxBump = bump;
    }
  }
  return maxBump;
}

function nextPrerelease(cur, label) {
  return [label, (cur && label === cur[0]) ? cur[1] + 1 : 1];
}

function targetPrereleaseBase(v, kind) {
  switch (kind) {
    case 'premajor':
      if (v.release && v.minor === 0 && v.patch === 0) {
        return v.stable();
      }
      return v.bump(bumpLevels.MAJOR);
    case 'preminor':
      if (v.release && v.patch === 0) {
        return v.stable();
      }
      return v.bump(bumpLevels.MINOR);
    case 'prepatch':
      if (v.release) {
        return v.stable();
      }
      return v.bump(bumpLevels.PATCH);
    default:
      throw new Error(`Invalid prerelease bump: ${kind}`);
  }
}

export function bumpVersion(v, b) {
  switch (b.kind) {
    case 'major':
    case 'minor':
    case 'patch':
      return v.bump(b.level);
    case 'premajor':
    case 'preminor':
    case 'prepatch': {
      const base = targetPrereleaseBase(v, b.kind);
      const sameBase = Version.compare(v.stable(), base.stable()) === 0;
      const rel = nextPrerelease(sameBase ? v.release : undefined, b.release);
      return new Version(base.major, base.minor, base.patch, rel);
    }
    default:
      throw new Error(`Invalid bump: ${b}`);
  }
}

export function parsePrefixFilter(value) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
  const parts = normalized.split('.');
  if (parts.length > 3 || parts.some((p) => p === '')) {
    throw new Error(`Invalid prefix-filter: ${trimmed}`);
  }
  let mode, tag;
  switch (parts.length) {
    case 1:
      tag = `v${parts[0]}.0.0`;
      mode = 'major';
      break;
    case 2:
      tag = `v${parts[0]}.${parts[1]}.0`;
      mode = 'minor';
      break;
    case 3:
      tag = `v${parts[0]}.${parts[1]}.${parts[2]}`;
      mode = 'exact';
      break;
    default:
      throw new Error(`Invalid prefix-filter: ${trimmed}`);
  }
  const version = Version.parseTag(tag);
  if (!version || version.release) {
    throw new Error(`Invalid prefix-filter: ${trimmed}`);
  }
  console.log(`Using prefix filter: v${normalized}`);
  return {prefix: `v${normalized}`, version, mode};
}

function matchesPrefix(version, filter) {
  const tag = version.toString();
  if (filter.mode === 'exact') {
    return tag === filter.prefix || tag.startsWith(`${filter.prefix}-`);
  }
  return tag.startsWith(`${filter.prefix}.`);
}

function tagRefPrefix(filter) {
  if (!filter) {
    return 'tags';
  }
  switch (filter.mode) {
    case 'major':
    case 'minor':
      return `tags/${filter.prefix}.`;
    case 'exact':
      return `tags/${filter.prefix}`;
    default:
      throw new Error(`Invalid prefix filter mode: ${filter.mode}`);
  }
}

function parseBoolean(value) {
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
      return true;
    case '0':
    case 'false':
    case 'no':
      return false;
    default:
      throw new Error(`Invalid boolean input: ${value}`);
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
  return !!process.env['CI'] && !process.env['FORGEJO_API_URL'];
}

if (isGitHub() || import.meta.main) {
  await main();
}
