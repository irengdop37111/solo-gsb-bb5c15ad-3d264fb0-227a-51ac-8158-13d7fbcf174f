import type {
  Analysis,
  ClauseDocument,
  ClauseNode,
  Issue,
  IssueType,
  RefOccurrence,
} from '../../shared/model';
import { analyze, locateSentence } from './analyzer';
import { diffIssueBaseline } from './issueBaseline';
import { applyStructuralChange } from './rewriter';
import { findNode } from './tree';
import { formatOrdinal } from './numeral';
import { uid } from './uid';

/**
 * 修订沙盒：条级删除 / 移位 / 换号的预演。
 * 预演在文档克隆上复用现有结构改写（applyStructuralChange）与分析（analyze）逻辑，
 * 不改动正文、不进入撤销历史；结果按来源节点列出，可点击定位当前正文。
 * 预演记录生成时的文档版本，正文变化后失效并禁止应用；
 * 未失效时可把操作与全部引用改写作为一步提交，支持整体撤销 / 重做。
 * 预演为会话内临时状态：不持久化、不随 JSON 导出。
 */

export type SandboxOpKind = 'delete' | 'move' | 'renumber';

export interface SandboxOp {
  kind: SandboxOpKind;
  /** 目标条（稳定节点 ID） */
  articleId: string;
  /** move / renumber：目标位置（第 N 位 / 第 N 条，1 起） */
  targetOrdinal?: number;
}

/** 将被改写的引用（区间为预演生成时当前正文中的偏移） */
export interface SandboxRewriteRow {
  key: string;
  /** 来源节点（稳定 ID），界面按来源节点分组列出 */
  nodeId: string;
  start: number;
  end: number;
  /** 引用原文 */
  raw: string;
  /** 改写后的文字 */
  text: string;
}

/** 不会被改写的引用（断链 / 歧义 / 目标被删除等，附原因） */
export interface SandboxSkippedRow {
  key: string;
  nodeId: string;
  start: number;
  end: number;
  raw: string;
  reason: string;
  targetMissing: boolean;
}

/** 将新增 / 将消失的断链与循环问题 */
export interface SandboxIssueRow {
  key: string;
  type: IssueType;
  message: string;
  /** 来源节点（稳定 ID） */
  sourceNodeId: string;
  cycleNodeIds?: string[];
  /** 在当前正文中的定位；无法定位（如环上节点均已删除）时为 null */
  jump: { nodeId: string; start: number; end: number; refKey?: string } | null;
}

export interface SandboxPreview {
  id: string;
  op: SandboxOp;
  /** 操作描述（界面展示） */
  opLabel: string;
  /** 生成时的文档版本（doc.updatedAt），正文变化后预演失效 */
  baseUpdatedAt: number;
  createdAt: number;
  /** 将被改写的引用（按文档顺序） */
  rewrites: SandboxRewriteRow[];
  /** 不会被改写的引用（按文档顺序） */
  skipped: SandboxSkippedRow[];
  /** 将新增的断链 / 循环问题 */
  issuesAdded: SandboxIssueRow[];
  /** 将消失的断链 / 循环问题 */
  issuesResolved: SandboxIssueRow[];
  /** 预演结果文档（生成时正文的克隆 + 原子改写；应用时整体提交） */
  previewDoc: ClauseDocument;
  /**
   * 生成时的正文对象引用（失效判据）：store 对正文不可变更新，
   * 仅当当前正文仍为该对象（updatedAt 一致）时预演可应用。
   */
  baseDoc: ClauseDocument;
}

/** 预演关注的问题类型：断链与循环 */
const SANDBOX_ISSUE_TYPES: readonly IssueType[] = ['broken', 'cycle'];

/** 校验操作参数；合法时返回 null，否则返回原因（供界面提示） */
export function validateSandboxOp(analysis: Analysis, op: SandboxOp): string | null {
  const node = analysis.nodes[op.articleId];
  if (!node || node.kind !== 'article') return '目标条款不存在，请重新选择';
  const count = analysis.articles.length;
  if (op.kind === 'delete') return null;
  const target = op.targetOrdinal;
  if (!Number.isInteger(target) || target! < 1 || target! > count) {
    return `目标位置需在 1 到 ${count} 之间`;
  }
  const currentIndex = analysis.articles.findIndex((a) => a.id === op.articleId);
  if (target === currentIndex + 1) return '目标位置与当前相同，无需调整';
  return null;
}

/**
 * 构造与正文编辑页一致的结构操作 mutator：
 * 删除 / 移位 / 换号与 store 的 deleteNode、reorderSibling、renumberArticle 同语义
 * （换号 N 即移动到第 N 位；toIndex 为删除源节点后的目标下标）。
 */
export function buildSandboxMutator(op: SandboxOp): ((root: ClauseNode[]) => void) | null {
  if (op.kind === 'delete') {
    return (root) => {
      const found = findNode(root, op.articleId);
      if (!found) return;
      found.parent.splice(found.index, 1);
    };
  }
  const target = op.targetOrdinal;
  if (!Number.isInteger(target) || target! < 1) return null;
  return (root) => {
    const found = findNode(root, op.articleId);
    if (!found) return;
    const [node] = found.parent.splice(found.index, 1);
    const clamped = Math.max(0, Math.min(target! - 1, found.parent.length));
    found.parent.splice(clamped, 0, node);
  };
}

/** 操作的人类可读描述 */
export function describeSandboxOp(analysis: Analysis, op: SandboxOp): string {
  const a = analysis.nodes[op.articleId];
  const label = a
    ? `第${formatOrdinal(a.ordinal)}条${a.suffix ? `之${a.suffix}` : ''}`
    : '（未知条款）';
  const title = a?.title ? `【${a.title}】` : '';
  switch (op.kind) {
    case 'delete':
      return `删除 ${label}${title}`;
    case 'move':
      return `${label}${title} 移位到第 ${op.targetOrdinal ?? '?'} 位`;
    case 'renumber':
      return `${label}${title} 换号为第${formatOrdinal(op.targetOrdinal ?? 0)}条`;
  }
}

/**
 * 生成预演：在文档克隆上执行结构操作并复用现有改写 / 分析逻辑。
 * - applyStructuralChange 内部克隆正文树，传入文档不被改动；
 * - 预演文档重新 analyze（含当前歧义确认记录）；
 * - 问题变化复用问题基线的稳定身份对齐（新增 = 预演结果有而当前没有，消失反之），
 *   仅列出断链与循环两类。
 * 返回 null 表示操作非法（validateSandboxOp 给出原因）。
 */
export function createSandboxPreview(
  doc: ClauseDocument,
  analysis: Analysis,
  confirmed: Record<string, string>,
  op: SandboxOp,
  now = Date.now(),
): SandboxPreview | null {
  if (validateSandboxOp(analysis, op)) return null;
  const mutator = buildSandboxMutator(op);
  if (!mutator) return null;

  // 结构改写（在克隆上执行）+ 全量重新分析
  const result = applyStructuralChange(doc, analysis, mutator);
  const after = analyze(result.doc, { confirmed });
  // 稳定身份对齐：当前分析 → 预演分析
  const diff = diffIssueBaseline(analysis, after);

  const rewrites: SandboxRewriteRow[] = result.changes.map((c, i) => ({
    key: `rw:${c.nodeId}:${c.start}:${i}`,
    nodeId: c.nodeId,
    start: c.start,
    end: c.end,
    raw: c.raw,
    text: c.text,
  }));
  // 来源节点随操作被删除的引用不属于“不改写”（其正文整体消失），从列表剔除
  const skipped: SandboxSkippedRow[] = result.skipped
    .filter((s) => findNode(result.doc.root, s.nodeId))
    .map((s, i) => ({
      key: `sk:${s.nodeId}:${s.start}:${i}`,
      nodeId: s.nodeId,
      start: s.start,
      end: s.end,
      raw: s.raw,
      reason: s.reason,
      targetMissing: s.targetMissing,
    }));

  const issuesAdded = diff.added
    .filter((e) => SANDBOX_ISSUE_TYPES.includes(e.type))
    .map((e) => toIssueRow(e.current!, 'added', analysis));
  const issuesResolved = diff.resolved
    .filter((e) => SANDBOX_ISSUE_TYPES.includes(e.type))
    .map((e) => toIssueRow(e.baseline!, 'resolved', analysis));

  return {
    id: uid('sbx'),
    op,
    opLabel: describeSandboxOp(analysis, op),
    baseUpdatedAt: doc.updatedAt,
    createdAt: now,
    rewrites,
    skipped,
    issuesAdded,
    issuesResolved,
    previewDoc: result.doc,
    baseDoc: doc,
  };
}

/** 预演是否已失效：正文在生成后发生过任何变化（对象身份或版本号不一致） */
export function isSandboxStale(preview: SandboxPreview, doc: ClauseDocument): boolean {
  return preview.baseDoc !== doc || preview.baseUpdatedAt !== doc.updatedAt;
}

function toIssueRow(
  issue: Issue,
  status: 'added' | 'resolved',
  current: Analysis,
): SandboxIssueRow {
  return {
    key: `${status}:${issue.identity}`,
    type: issue.type,
    message: issue.message,
    sourceNodeId: issue.sourceNodeId,
    cycleNodeIds: issue.cycleNodeIds,
    jump: status === 'resolved' ? jumpOfExisting(issue) : locateInCurrent(issue, current),
  };
}

/** 将消失的问题：当前正文中即存在，直接取其源句定位 */
function jumpOfExisting(issue: Issue): SandboxIssueRow['jump'] {
  return {
    nodeId: issue.sourceNodeId,
    start: issue.sentenceStart,
    end: issue.sentenceEnd,
    refKey: issue.refKey,
  };
}

/**
 * 将新增的问题：在当前正文中定位其来源。
 * 断链按「源节点 ID + 引用原文 + 同文序次」在当前分析中找回引用并定位源句
 * （如当前有效、预演后目标被删除的引用）；找不到引用时退化为节点级定位。
 * 循环定位到环上第一个现存节点。
 */
function locateInCurrent(issue: Issue, current: Analysis): SandboxIssueRow['jump'] {
  if (issue.type === 'cycle') {
    const nid = issue.cycleNodeIds?.find((id) => current.nodes[id]);
    if (!nid) return null;
    return { nodeId: nid, start: 0, end: Math.max(1, current.nodes[nid].text.length) };
  }
  const node = current.nodes[issue.sourceNodeId];
  if (!node) return null;
  const occ = occurrenceOfIdentity(current, issue.identity);
  if (occ) {
    const s = locateSentence(node.text, occ.span.start, occ.span.end);
    return { nodeId: node.id, start: s.start, end: s.end, refKey: occ.key };
  }
  return { nodeId: node.id, start: 0, end: Math.max(1, node.text.length) };
}

/** 按问题身份（类型::源节点 ID::引用原文::同文序次）在当前分析中找回引用出现 */
function occurrenceOfIdentity(current: Analysis, identity: string): RefOccurrence | undefined {
  const parts = identity.split('::');
  if (parts.length < 4) return undefined;
  const occurrenceIndex = Number(parts[parts.length - 1]);
  if (!Number.isInteger(occurrenceIndex)) return undefined;
  const nodeId = parts[1];
  const raw = parts.slice(2, -1).join('::');
  return current.occurrences.find(
    (o) => o.nodeId === nodeId && o.span.raw === raw && o.occurrenceIndex === occurrenceIndex,
  );
}
