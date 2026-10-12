// Configuration integrity audit: run after a device Read to catch the kinds
// of silent settings corruption this project has actually hit -- a custom
// hold-tap on J/Z being replaced by a generic behavior in NVS, combos that
// can never fire, references to layers that don't exist. Pure analysis over
// data the editor already holds after a Read; no RPCs of its own except
// resolveKeyBindingRpc (cache-only once behaviors are loaded).
import type { KeymapProject } from '../types';
import {
  getRawBindingsSnapshot,
  getBehaviorCacheEntries,
  resolveKeyBindingRpc,
  CUSTOM_HOLDTAP_RE,
} from './usbService';

export interface AuditFinding {
  severity: 'error' | 'warning';
  category: string;
  message: string;
}

// Kept for the Diagnostics tab to show the latest result without threading
// state through App -- the audit only ever runs from one place at a time.
export let lastAuditResults: AuditFinding[] | null = null;
export let lastAuditAt: string | null = null;

function comboPositionsKey(positions: string[]): string {
  return [...positions].sort().join(',');
}

export async function runConfigAudit(project: KeymapProject): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const layerCount = project.layers.length;
  const raw = getRawBindingsSnapshot();
  const behaviors = getBehaviorCacheEntries();
  const behaviorIds = new Set(behaviors.map(b => b.id));

  // --- 1. Raw bindings referencing behaviors the firmware doesn't have.
  // This is what NVS corruption looks like from the outside: a stored
  // behavior_local_id that no longer resolves.
  const unknownBehaviorPositions: string[] = [];
  for (const [key, b] of Object.entries(raw)) {
    if (b.behaviorId !== 0 && !behaviorIds.has(b.behaviorId)) {
      unknownBehaviorPositions.push(`${key}(id=${b.behaviorId})`);
    }
  }
  if (unknownBehaviorPositions.length > 0) {
    findings.push({
      severity: 'error',
      category: 'behavior参照',
      message: `実機に存在しないbehaviorを参照しているキーがあります: ${unknownBehaviorPositions.slice(0, 8).join(', ')}${unknownBehaviorPositions.length > 8 ? ` 他${unknownBehaviorPositions.length - 8}件` : ''}。NVS設定の破損か、behavior構成が変わったファームウェア更新後の残骸の可能性があります`,
    });
  }

  // --- 2. Custom hold-taps (lt6_j / mt_shift_z style) that exist in the
  // firmware but are no longer referenced by any key. This is the J/Z
  // incident's signature: the custom behavior is still compiled in, but the
  // stored keymap silently swapped it for a generic &lt/&mt.
  if (Object.keys(raw).length > 0) {
    const referencedIds = new Set(Object.values(raw).map(b => b.behaviorId));
    for (const beh of behaviors) {
      if (CUSTOM_HOLDTAP_RE.test(beh.displayName) && !referencedIds.has(beh.id)) {
        findings.push({
          severity: 'warning',
          category: 'カスタムbehavior',
          message: `カスタムbehavior「${beh.displayName}」がどのキーからも参照されていません。本来このbehaviorを使うキーが汎用のLayer-Tap/Mod-Tapに置き換わっていないか確認してください（過去のJ/Z上書き問題と同じ症状）`,
        });
      }
    }
  }

  // --- 3. Layer references out of range (keymap + combos).
  const badLayerRefs: string[] = [];
  for (const layer of project.layers) {
    for (const key of layer.keys) {
      const b = key.binding;
      if ((b.type === 'momentary' || b.type === 'toggle' || b.type === 'to-layer' || b.type === 'layer-tap') &&
          b.layer !== undefined && (b.layer < 0 || b.layer >= layerCount)) {
        badLayerRefs.push(`${key.id}@L${layer.index}→layer${b.layer}`);
      }
    }
  }
  for (const combo of project.combos) {
    if (combo.binding.layer !== undefined && (combo.binding.layer < 0 || combo.binding.layer >= layerCount)) {
      badLayerRefs.push(`combo「${combo.name}」→layer${combo.binding.layer}`);
    }
    // combo.layers gets its own richer diagnostic below (distinct-value and
    // total-length breakdown) instead of one line per bad entry -- a single
    // combo's array blowing past what 32 layer_mask bits could ever produce
    // needs more than a truncated list to diagnose (see
    // project_scroll_combo_layer_mask_corruption memory).
    const badInThisCombo = (combo.layers || []).filter(l => l < 0 || l >= layerCount);
    if (badInThisCombo.length > 0) {
      const distinct = [...new Set(badInThisCombo)].sort((a, b) => a - b);
      const totalLen = (combo.layers || []).length;
      findings.push({
        severity: 'error',
        category: 'レイヤー参照',
        message: `コンボ「${combo.name}」のactive layersに存在しないレイヤー参照があります。配列全体のサイズ=${totalLen}件、うち範囲外(0〜${layerCount - 1}外)=${badInThisCombo.length}件、範囲外の一意な値=${distinct.length}件（${distinct.slice(0, 10).join(',')}${distinct.length > 10 ? '...' : ''}、最小${distinct[0]}〜最大${distinct[distinct.length - 1]}）`,
      });
    }
  }
  if (badLayerRefs.length > 0) {
    findings.push({
      severity: 'error',
      category: 'レイヤー参照',
      message: `存在しないレイヤー（0〜${layerCount - 1}の範囲外）への参照: ${badLayerRefs.slice(0, 6).join(', ')}${badLayerRefs.length > 6 ? ` 他${badLayerRefs.length - 6}件` : ''}`,
    });
  }

  // --- 4. Combo checks: unfireable/conflicting definitions.
  // Duplicate-name check first: distinct from the position-duplicate check
  // below (same name, potentially different positions/bindings) -- a sign
  // that the same device combo got appended into local state more than
  // once, e.g. across repeated Read/merge cycles, rather than an
  // intentional coincidence. Report once per name with the total count, not
  // once per pair, so N duplicates doesn't produce N*(N-1)/2 near-identical
  // findings.
  const nameCounts = new Map<string, number>();
  for (const combo of project.combos) {
    nameCounts.set(combo.name, (nameCounts.get(combo.name) ?? 0) + 1);
  }
  for (const [name, count] of nameCounts) {
    if (count > 1) {
      findings.push({
        severity: 'error',
        category: 'コンボ',
        message: `コンボ「${name}」という名前のコンボがローカルに${count}個あります。同じ設定が重複して保存されている可能性があります（Readの繰り返しなどで蓄積した可能性）。診断のため他の項目より先にこれを解消してください`,
      });
    }
  }

  const seenPositionSets = new Map<string, string>();
  for (const combo of project.combos) {
    if (combo.keyPositions.length < 2) {
      findings.push({
        severity: 'error',
        category: 'コンボ',
        message: `コンボ「${combo.name}」のキーが${combo.keyPositions.length}個しかありません（最低2個）。このままWriteするとスキップされます`,
      });
    }
    const posKey = comboPositionsKey(combo.keyPositions);
    const dup = seenPositionSets.get(posKey);
    if (dup !== undefined) {
      findings.push({
        severity: 'error',
        category: 'コンボ',
        message: `コンボ「${dup}」と「${combo.name}」が完全に同じキー組み合わせです。片方しか発火しません`,
      });
    } else {
      seenPositionSets.set(posKey, combo.name);
    }
    // Resolver check only makes sense with the device's behavior table
    // loaded -- with an empty cache (disconnected re-run) every combo would
    // false-positive as unresolvable.
    if (behaviors.length > 0) {
      const resolved = await resolveKeyBindingRpc(combo.binding);
      if (!resolved) {
        findings.push({
          severity: 'error',
          category: 'コンボ',
          message: `コンボ「${combo.name}」の出力（${combo.binding.type}/${combo.binding.keyCode}）を実機のbehaviorに変換できません。このままWriteするとスキップされます`,
        });
      }
    }
  }
  // Subset relations: A ⊂ B means A can swallow B's keys (or vice versa)
  // depending on timing. The firmware handles overlap since the 2026-07-08
  // fix, but a shorter-timeout superset is still effectively dead.
  for (const a of project.combos) {
    for (const b of project.combos) {
      if (a === b || a.keyPositions.length >= b.keyPositions.length) continue;
      const bSet = new Set(b.keyPositions);
      if (a.keyPositions.every(p => bSet.has(p)) && a.timeoutMs >= b.timeoutMs) {
        findings.push({
          severity: 'warning',
          category: 'コンボ',
          message: `コンボ「${a.name}」(${a.keyPositions.join('+')}, ${a.timeoutMs}ms)は「${b.name}」(${b.keyPositions.join('+')}, ${b.timeoutMs}ms)の部分集合で、タイムアウトが同じか長いため「${b.name}」側が発火しにくくなっています。「${b.name}」のタイムアウトを長くするか確認してください`,
        });
      }
    }
  }

  // --- 5. Macro checks.
  const macroNames = new Set(project.macros.map(m => m.name));
  const referencedMacros = new Set<string>();
  for (const layer of project.layers) {
    for (const key of layer.keys) {
      const kc = key.binding.keyCode;
      if (kc?.startsWith('&') && kc.length > 1) {
        referencedMacros.add(kc.substring(1));
      }
    }
  }
  for (const name of referencedMacros) {
    // A key referencing "&name" must resolve to either an editor macro or a
    // firmware behavior of that display name at Write time. Firmware-side
    // resolution needs the behavior table, so only judge when it's loaded
    // (otherwise every legit firmware macro would false-positive offline).
    const inFirmware = behaviors.some(b => b.displayName === name);
    if (!macroNames.has(name) && behaviors.length > 0 && !inFirmware) {
      findings.push({
        severity: 'error',
        category: 'マクロ',
        message: `キーが参照しているマクロ「&${name}」がマクロ一覧にも実機behaviorにも存在しません。Write時にこのキーは書き込みに失敗します`,
      });
    }
  }
  for (const macro of project.macros) {
    if (referencedMacros.has(macro.name) && macro.deviceId === undefined) {
      findings.push({
        severity: 'warning',
        category: 'マクロ',
        message: `マクロ「${macro.name}」はキーから参照されていますが、まだ実機に書き込まれていません（Write時に自動で書き込みます）`,
      });
    }
    if (referencedMacros.has(macro.name) && macro.bindings.length === 0) {
      findings.push({
        severity: 'warning',
        category: 'マクロ',
        message: `マクロ「${macro.name}」はキーから参照されていますが、ステップが空です`,
      });
    }
  }

  lastAuditResults = findings;
  lastAuditAt = new Date().toLocaleTimeString('ja-JP');
  return findings;
}
