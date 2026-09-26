import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import type {
  SandboxIssueRow,
  SandboxOp,
  SandboxOpKind,
  SandboxRewriteRow,
  SandboxSkippedRow,
} from '../lib/sandbox';
import { labelOfNode, shortArticleLabel } from '../lib/labels';

const TYPE_META: Record<string, { label: string; cls: string; icon: string }> = {
  broken: { label: '断链', cls: 'it-broken', icon: '⛓' },
  cycle: { label: '循环引用', cls: 'it-cycle', icon: '🔄' },
};

const OP_KINDS: { kind: SandboxOpKind; label: string }[] = [
  { kind: 'delete', label: '删除该条' },
  { kind: 'move', label: '移位' },
  { kind: 'renumber', label: '换号' },
];

function formatTime(ms: number): string {
  if (!ms) return '时间未知';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 修订沙盒：条级删除 / 移位 / 换号的预演入口。
 * 预演在文档克隆上复用结构改写与分析逻辑，不改动正文、不进入撤销历史；
 * 正文变化后预演失效并禁止应用；未失效时可一步提交（可整体撤销 / 重做）。
 */
export function SandboxPanel() {
  const { store, highlighter } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { analysis, sandbox } = store.getSnapshot();

  const [articleId, setArticleId] = useState('');
  const [kind, setKind] = useState<SandboxOpKind>('delete');
  const [targetText, setTargetText] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const [lastOp, setLastOp] = useState<SandboxOp | null>(null);

  const articles = analysis.articles;
  const selectedId = articles.some((a) => a.id === articleId)
    ? articleId
    : (articles[0]?.id ?? '');
  const selected = selectedId ? analysis.nodes[selectedId] : null;

  // 切换条款 / 操作类型时，把目标位置默认填为该条当前条号
  useEffect(() => {
    if (selected) setTargetText(String(selected.ordinal));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, kind]);

  const stale = store.isSandboxStale();

  const buildOp = (): SandboxOp | null => {
    if (!selectedId) return null;
    if (kind === 'delete') return { kind, articleId: selectedId };
    return { kind, articleId: selectedId, targetOrdinal: Number(targetText) };
  };

  const generate = (op?: SandboxOp) => {
    const built = op ?? buildOp();
    if (!built) {
      setError('请先选择条款');
      return;
    }
    const r = store.previewSandbox(built);
    if (!r.ok) {
      setError(r.error ?? '无法生成预演');
    } else {
      setError(null);
      setLastOp(built);
    }
  };

  const apply = () => {
    if (!store.applySandbox()) setError('预演已失效，请重新生成后再应用');
  };

  // 失效后偏移可能已过期：退化为节点级定位
  const jumpRange = (nodeId: string, start?: number, end?: number, refKey?: string) => {
    if (stale || start === undefined || end === undefined) {
      highlighter.jumpTo(nodeId);
    } else {
      highlighter.jumpTo(nodeId, { start, end }, refKey);
    }
  };

  // 将被改写的引用按来源节点分组（保持文档顺序）
  const rewriteGroups = useMemo(() => {
    if (!sandbox) return [];
    const map = new Map<string, SandboxRewriteRow[]>();
    for (const row of sandbox.rewrites) {
      const list = map.get(row.nodeId) ?? [];
      list.push(row);
      map.set(row.nodeId, list);
    }
    return [...map.entries()];
  }, [sandbox]);

  return (
    <div className="sandbox-panel">
      <div className="sandbox-form">
        <div className="sandbox-form-row">
          <label className="sandbox-label">条款</label>
          <select
            className="impact-select sandbox-select"
            value={selectedId}
            onChange={(e) => setArticleId(e.target.value)}
            aria-label="选择要预演的条款"
          >
            {articles.map((a) => (
              <option key={a.id} value={a.id}>
                {shortArticleLabel(a.ordinal, a.suffix)}
                {a.title ? ` ${a.title}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="sandbox-form-row">
          <label className="sandbox-label">操作</label>
          <div className="sandbox-kinds" role="radiogroup" aria-label="操作类型">
            {OP_KINDS.map((k) => (
              <button
                key={k.kind}
                role="radio"
                aria-checked={kind === k.kind}
                className={kind === k.kind ? 'active' : ''}
                onClick={() => setKind(k.kind)}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>
        {kind !== 'delete' && (
          <div className="sandbox-form-row">
            <label className="sandbox-label">{kind === 'move' ? '移位到' : '换号为'}</label>
            <span className="sandbox-num-wrap">
              第
              <input
                className="sandbox-num"
                value={targetText}
                inputMode="numeric"
                onChange={(e) => setTargetText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') generate();
                }}
                aria-label="目标位置"
              />
              {kind === 'move' ? '位' : '条'}
            </span>
          </div>
        )}
        <div className="sandbox-form-row sandbox-actions">
          <button
            className="primary"
            disabled={articles.length === 0}
            onClick={() => generate()}
            title="在文档克隆上预演该操作，不改动正文"
          >
            ▶ 生成预演
          </button>
          {sandbox && (
            <button className="small" onClick={() => store.clearSandbox()}>
              清除预演
            </button>
          )}
        </div>
        {error && <div className="sandbox-error">{error}</div>}
        {articles.length === 0 && (
          <div className="empty-hint">暂无条款。请先导入条款文本。</div>
        )}
      </div>

      {sandbox && (
        <div className="sandbox-result">
          <div className="sandbox-result-head">
            <span className="sandbox-op-label">{sandbox.opLabel}</span>
            <span className={`sandbox-version ${stale ? 'is-stale' : ''}`}>
              {stale ? '✕ 已失效' : '✓ 有效'} · 基于版本 {formatTime(sandbox.baseUpdatedAt)}
            </span>
          </div>

          {stale && (
            <div className="impact-stale sandbox-stale">
              正文已变化，本预演已失效并禁止应用；下列结果基于生成时版本（点击仅定位到节点）。
              <button className="link-btn" onClick={() => lastOp && generate(lastOp)}>
                按原操作重新生成
              </button>
            </div>
          )}

          <div className="sandbox-summary">
            将改写 <strong>{sandbox.rewrites.length}</strong> 处引用 · 不改写{' '}
            <strong>{sandbox.skipped.length}</strong> 处 · 新增问题{' '}
            <strong>{sandbox.issuesAdded.length}</strong> · 消失问题{' '}
            <strong>{sandbox.issuesResolved.length}</strong>
          </div>

          <div className="sandbox-scroll">
            <section className="sandbox-section">
              <div className="term-section-title">
                将被改写的引用（{sandbox.rewrites.length}，按来源节点分组）
              </div>
              {rewriteGroups.length === 0 && (
                <div className="empty-hint">没有引用需要改写。</div>
              )}
              {rewriteGroups.map(([nodeId, rows]) => (
                <div key={nodeId} className="sandbox-group">
                  <button
                    className="link-btn sandbox-group-head"
                    onClick={() => jumpRange(nodeId)}
                    title="定位到当前正文中的来源节点"
                  >
                    {labelOfNode(analysis, nodeId)}
                  </button>
                  {rows.map((row) => (
                    <button
                      key={row.key}
                      className="issue-sentence sandbox-rewrite-row"
                      onClick={() => jumpRange(row.nodeId, row.start, row.end)}
                      title="定位到当前正文中的该引用"
                    >
                      「{row.raw}」<span className="sandbox-arrow">→</span>「{row.text}」
                    </button>
                  ))}
                </div>
              ))}
            </section>

            {sandbox.skipped.length > 0 && (
              <section className="sandbox-section">
                <div className="term-section-title">
                  不改写的引用（{sandbox.skipped.length}）
                </div>
                {sandbox.skipped.map((row) => (
                  <SkippedRow
                    key={row.key}
                    row={row}
                    nodeLabel={labelOfNode(analysis, row.nodeId)}
                    onJump={() => jumpRange(row.nodeId, row.start, row.end)}
                  />
                ))}
              </section>
            )}

            <section className="sandbox-section">
              <div className="term-section-title">
                将新增的断链 / 循环（{sandbox.issuesAdded.length}）
              </div>
              {sandbox.issuesAdded.length === 0 && (
                <div className="empty-hint">不会新增断链或循环问题。</div>
              )}
              {sandbox.issuesAdded.map((row) => (
                <IssueChangeRow
                  key={row.key}
                  row={row}
                  badge="新增"
                  badgeCls="bl-added"
                  sourceLabel={labelOfNode(analysis, row.sourceNodeId)}
                  onJump={() =>
                    row.jump && jumpRange(row.jump.nodeId, row.jump.start, row.jump.end, row.jump.refKey)
                  }
                />
              ))}
            </section>

            <section className="sandbox-section">
              <div className="term-section-title">
                将消失的断链 / 循环（{sandbox.issuesResolved.length}）
              </div>
              {sandbox.issuesResolved.length === 0 && (
                <div className="empty-hint">没有断链或循环问题会消失。</div>
              )}
              {sandbox.issuesResolved.map((row) => (
                <IssueChangeRow
                  key={row.key}
                  row={row}
                  badge="消失"
                  badgeCls="bl-resolved"
                  sourceLabel={labelOfNode(analysis, row.sourceNodeId)}
                  onJump={() =>
                    row.jump && jumpRange(row.jump.nodeId, row.jump.start, row.jump.end, row.jump.refKey)
                  }
                />
              ))}
            </section>
          </div>

          <div className="sandbox-apply">
            <button
              className="primary"
              disabled={stale}
              onClick={apply}
              title={
                stale
                  ? '正文已变化，预演失效，禁止应用'
                  : '把该操作及全部引用改写作为一步提交，可整体撤销 / 重做'
              }
            >
              ✓ 应用该操作（一步提交，可整体撤销）
            </button>
          </div>
        </div>
      )}

      <div className="panel-footer">
        预演在文档克隆上进行，不改动正文、不进入撤销历史；记录生成时的文档版本，正文变化后失效并禁止应用。预演仅存在于当前会话，不持久化、不随 JSON 导出。
      </div>
    </div>
  );
}

function SkippedRow({
  row,
  nodeLabel,
  onJump,
}: {
  row: SandboxSkippedRow;
  nodeLabel: string;
  onJump: () => void;
}) {
  return (
    <div className="issue-row it-ambiguous sandbox-skipped-row">
      <div className="issue-row-head">
        <span className="issue-type-tag">「{row.raw}」</span>
        <span className="issue-source-label">{nodeLabel}</span>
      </div>
      <div className="issue-message">{row.reason}</div>
      <button className="link-btn" onClick={onJump} title="定位到当前正文中的该引用">
        → 定位当前正文
      </button>
    </div>
  );
}

function IssueChangeRow({
  row,
  badge,
  badgeCls,
  sourceLabel,
  onJump,
}: {
  row: SandboxIssueRow;
  badge: string;
  badgeCls: string;
  sourceLabel: string;
  onJump: () => void;
}) {
  const meta = TYPE_META[row.type] ?? TYPE_META.broken;
  return (
    <div className={`issue-row ${meta.cls} sandbox-issue-row`}>
      <div className="issue-row-head">
        <span className="issue-type-tag">
          <span className={`bl-badge ${badgeCls}`}>{badge}</span> {meta.icon} {meta.label}
        </span>
        <span className="issue-source-label">{sourceLabel}</span>
      </div>
      <div className="issue-message">{row.message}</div>
      {row.jump ? (
        <button className="link-btn" onClick={onJump} title="定位到当前正文">
          → 定位当前正文
        </button>
      ) : (
        <span className="sandbox-nojump">源节点已删除，不可跳转</span>
      )}
    </div>
  );
}
