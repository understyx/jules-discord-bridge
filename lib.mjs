// Pure helpers shared between bridge.mjs and the unit tests.
// Anything in here MUST be safe to import without side effects (no Discord
// client boot, no network, no env-coupled config). Move things into bridge.mjs
// the moment they need runtime state.

import fs from 'node:fs';

export const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;

// Max characters shown per bash artifact in a Discord reply.
const BASH_ARTIFACT_MAX = 1400;

/**
 * Format a plan object (from a `planGenerated` activity) into a human-readable
 * numbered list suitable for a Discord message.
 *
 * @param {object|null} plan - Jules plan object with a `steps` array.
 * @returns {string}
 */
export function formatPlan(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    return '*(no plan details)*';
  }
  return plan.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
}

/**
 * Format an array of Jules activity artifacts into a Discord-ready string.
 * Handles `bashOutput` (code block) and `changeSet` (diff summary).
 * Media artifacts are noted but not embedded.
 *
 * @param {Array} artifacts
 * @returns {string} May be empty string if there are no displayable artifacts.
 */
export function formatArtifacts(artifacts) {
  if (!artifacts || artifacts.length === 0) return '';
  const parts = [];
  for (const artifact of artifacts) {
    try {
      if (artifact.type === 'bashOutput') {
        const raw = artifact.toString();
        if (raw && raw.trim()) {
          const truncated =
            raw.length > BASH_ARTIFACT_MAX
              ? raw.slice(0, BASH_ARTIFACT_MAX) + '\n…(truncated)'
              : raw;
          parts.push(`\`\`\`\n${truncated}\n\`\`\``);
        }
      } else if (artifact.type === 'changeSet') {
        const parsed = artifact.parsed();
        if (parsed && parsed.files && parsed.files.length > 0) {
          const lines = parsed.files.map(
            (f) => `\`${f.path}\`: +${f.additions} -${f.deletions}`
          );
          parts.push(`**Changes:**\n${lines.join('\n')}`);
        }
      } else if (artifact.type === 'media') {
        parts.push(`*(media: ${artifact.format ?? 'unknown format'})*`);
      }
    } catch {
      // skip malformed artifacts
    }
  }
  return parts.join('\n\n');
}

export function buildContent(text, attachments) {
  let contentText = text || '';

  const failed = [];
  const savedPaths = [];
  for (const att of attachments) {
    if (att.error) {
      failed.push(`${att.name ?? 'unnamed'} (failed: ${att.error})`);
      continue;
    }
    if (att.data) {
      // Write to /tmp and inject path so agent can Read it
      const safe = (att.name || 'unnamed').replace(/[^a-zA-Z0-9._-]/g, '_');
      const dest = `/tmp/discord-${Date.now()}-${safe}`;
      fs.writeFileSync(dest, att.data);
      savedPaths.push(`${dest} (${att.type ?? 'unknown'}, ${att.size}b)`);
    }
  }
  if (savedPaths.length || failed.length) {
    let note = '';
    if (savedPaths.length) note += `\n\n[attachments: ${savedPaths.join(', ')}]`;
    if (failed.length) note += `\n\n[failed: ${failed.join(', ')}]`;
    if (!contentText) contentText = '(attachment)';
    contentText += note;
  }

  return contentText || null;
}

export function splitMessage(text, maxLen = 2000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  while (text.length > 0) {
    if (text.length <= maxLen) { chunks.push(text); break; }
    let idx = text.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.3) idx = text.lastIndexOf(' ', maxLen);
    if (idx < maxLen * 0.3) idx = maxLen;
    chunks.push(text.slice(0, idx));
    text = text.slice(idx).trimStart();
  }
  return chunks;
}
