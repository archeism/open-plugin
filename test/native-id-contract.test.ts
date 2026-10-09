import { expect, test } from 'bun:test';
import type { HostWriter } from '../src/host';
import type { PluginSource } from '../src/source';
import { claudeCodeWriter } from '../src/hosts/claude-code-writer';
import { codexWriter } from '../src/hosts/codex-writer';
import { cursorWriter } from '../src/hosts/cursor-writer';
import { dcodeWriter } from '../src/hosts/dcode-writer';
import { kimiWriter } from '../src/hosts/kimi-writer';
import { ompWriter } from '../src/hosts/omp-writer';

const rootPlugin: PluginSource = { dir: '/source/demo', name: 'demo' };
const marketplacePlugin: PluginSource = { ...rootPlugin, marketplace: 'personal' };

function identities(writer: HostWriter, plugin: PluginSource): { canonical: string; legacy: readonly string[] } {
  return {
    canonical: writer.plannedNativeId(plugin),
    legacy: writer.legacyNativeIds?.(plugin) ?? [],
  };
}

test('active adapters own the exact canonical and historical native identity matrix', () => {
  expect([
    claudeCodeWriter,
    codexWriter,
    ompWriter,
    dcodeWriter,
  ].map((writer) => ({ host: writer.id, root: identities(writer, rootPlugin), marketplace: identities(writer, marketplacePlugin) }))).toEqual([
    { host: 'claude-code', root: { canonical: 'demo@local', legacy: ['demo'] }, marketplace: { canonical: 'demo@personal', legacy: [] } },
    { host: 'codex', root: { canonical: 'demo@local', legacy: ['demo'] }, marketplace: { canonical: 'demo@personal', legacy: [] } },
    { host: 'omp', root: { canonical: 'demo@local', legacy: ['demo'] }, marketplace: { canonical: 'demo@personal', legacy: [] } },
    { host: 'dcode', root: { canonical: 'demo@local', legacy: ['demo'] }, marketplace: { canonical: 'demo@personal', legacy: [] } },
  ]);

  expect({
    cursorRoot: identities(cursorWriter, rootPlugin),
    cursorMarketplace: identities(cursorWriter, marketplacePlugin),
    kimiRoot: identities(kimiWriter, rootPlugin),
    kimiMarketplace: identities(kimiWriter, marketplacePlugin),
  }).toEqual({
    cursorRoot: { canonical: 'demo', legacy: [] },
    cursorMarketplace: { canonical: 'demo', legacy: ['demo@personal'] },
    kimiRoot: { canonical: 'demo', legacy: [] },
    kimiMarketplace: { canonical: 'demo@personal', legacy: ['demo'] },
  });

  expect([
    claudeCodeWriter,
    codexWriter,
    ompWriter,
    dcodeWriter,
  ].map((writer) => ({
    host: writer.id,
    local: writer.unresolvedLegacyNativeIdConflicts?.('demo', 'demo@local'),
    marketplace: writer.unresolvedLegacyNativeIdConflicts?.('demo', 'demo@personal'),
    canonical: writer.unresolvedLegacyNativeIdConflicts?.('demo@local', 'demo@local'),
  }))).toEqual([
    { host: 'claude-code', local: true, marketplace: false, canonical: false },
    { host: 'codex', local: true, marketplace: false, canonical: false },
    { host: 'omp', local: true, marketplace: false, canonical: false },
    { host: 'dcode', local: true, marketplace: false, canonical: false },
  ]);
  expect({
    cursorLegacyToBare: cursorWriter.unresolvedLegacyNativeIdConflicts?.('demo@personal', 'demo'),
    cursorLegacyToQualified: cursorWriter.unresolvedLegacyNativeIdConflicts?.('demo@personal', 'demo@other'),
    cursorCanonical: cursorWriter.unresolvedLegacyNativeIdConflicts?.('demo', 'demo'),
    kimiBareToRoot: kimiWriter.unresolvedLegacyNativeIdConflicts?.('demo', 'demo'),
    kimiBareToMarketplace: kimiWriter.unresolvedLegacyNativeIdConflicts?.('demo', 'demo@personal'),
    kimiCanonical: kimiWriter.unresolvedLegacyNativeIdConflicts?.('demo@personal', 'demo@personal'),
  }).toEqual({
    cursorLegacyToBare: true,
    cursorLegacyToQualified: true,
    cursorCanonical: false,
    kimiBareToRoot: true,
    kimiBareToMarketplace: true,
    kimiCanonical: false,
  });
});
