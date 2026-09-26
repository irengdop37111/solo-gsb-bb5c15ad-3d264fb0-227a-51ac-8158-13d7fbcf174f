import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import type { Analysis, Issue, IssueBaseline, IssueType, RefOccurrence } from '../../shared/model';
import { labelOfNode } from '../lib/labels';
import {
  analyzeIssueBaseline,
  diffIssueBaseline,
  type IssueBaselineDiff,
  type IssueDiffEntry,
  type IssueDiffStatus,
} from '../lib/issueBaseline';

const TYPE_META: Record<IssueType, { label: string; cls: string; icon: string }> = {
  broken: { label: '断链', cls: 'it-broken', icon: '⛓' },
  self: { label: '自引用', cls: 'it-self', icon: '↺' },
  cycle: { label: '循环引用', cls: 'it-cycle', icon: '🔄' },
  ambiguous: { label: '歧义引用', cls: 'it-ambiguous', icon: '❓' },
};

const ORDER: IssueType[] = ['broken', 'cycle', 'self', 'ambiguous'];

function formatTime(ms: number): string {
  if (!ms) return '时间未知';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function IssuePanel() {
  const { store } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { analysis, issueBaselines } = store.getSnapshot();
  const [filter, setFilter] = useState<IssueType | 'all'>('all');
  const [activeBaselineId, setActiveBaselineId] = useState<string | null>(null);

  // 当前选中的基线被删除后自动退出比较
  useEffect(() => {
    if (activeBaselineId && !issueBaselines.some((b) => b.id === activeBaselineId)) {
      setActiveBaselineId(null);
    }
  }, [issueBaselines, activeBaselineId]);

  const groups = useMemo(() => {
    const map = new Map<IssueType, Issue[]>();
    for (const issue of analysis.issues) {
      const list = map.get(issue.type) ?? [];
      list.push(issue);
      map.set(issue.type, list);
    }
    return map;
  }, [analysis]);

  const visible =
    filter === 'all'
      ? analysis.issues
      : groups.get(filter) ?? [];

  const counts = ORDER.map((t) => [t, groups.get(t)?.length ?? 0] as const);

  const activeBaseline = issueBaselines.find((b) => b.id === activeBaselineId) ?? null;

  return (
    <div className="issue-panel">
      <BaselineBar
        baselines={issueBaselines}
        activeBaseline={activeBaseline}
        onSelect={setActiveBaselineId}
      />

      {activeBaseline ? (
        <BaselineCompare baseline={activeBaseline} live={analysis} onExit={() => setActiveBaselineId(null)} />
      ) : (
        <>
          <div className="issue-filters">
            <button
              className={filter === 'all' ? 'active' : ''}
              onClick={() => setFilter('all')}
            >
              全部 {analysis.issues.length}
            </button>
            {counts.map(([t, n]) => (
              <button
                key={t}
                className={`${TYPE_META[t].cls} ${filter === t ? 'active' : ''}`}
                disabled={n === 0}
                onClick={() => setFilter(t)}
              >
                {TYPE_META[t].icon} {TYPE_META[t].label} {n}
              </button>
            ))}
          </div>

          <div className="issue-list">
            {visible.length === 0 && (
              <div className="empty-hint">
                {analysis.issues.length === 0
                  ? '✓ 全部引用均可唯一定位，且不存在自引用或循环。'
                  : '该类别下暂无问题。'}
              </div>
            )}
            {visible.map((issue) => (
              <IssueRow key={issue.key} issue={issue} />
            ))}
          </div>

          <div className="panel-footer">
            点击问题可跳到源句；悬停正文引用可在关系视图中联动高亮。
          </div>
        </>
      )}
    </div>
  );
}

// ---------- 问题基线管理栏 ----------

function BaselineBar({
  baselines,
  activeBaseline,
  onSelect,
}: {
  baselines: IssueBaseline[];
  activeBaseline: IssueBaseline | null;
  onSelect: (id: string | null) => void;
}) {
  const { store } = useApp();
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);

  const save = () => {
    const id = store.saveIssueBaseline(name);
    setName('');
    // 保存后立即与该基线比较
    onSelect(id);
  };

  const removeBaseline = (b: IssueBaseline) => {
    if (confirm(`确定删除问题基线「${b.name}」？基线仅为检测结果快照，删除不影响正文。`)) {
      store.deleteIssueBaseline(b.id);
    }
  };

  return (
    <div className="baseline-bar">
      <button
        className={`baseline-bar-toggle ${open || activeBaseline ? 'active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="把当前检测结果保存为命名基线，再与实时结果比较"
      >
        📌 问题基线{baselines.length > 0 ? `（${baselines.length}）` : ''} {open ? '▾' : '▸'}
      </button>

      {(open || activeBaseline) && (
        <div className="baseline-bar-body">
          <div className="baseline-save">
            <input
              className="baseline-name-input"
              placeholder="为当前检测结果命名，如「一审基线」"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
              }}
            />
            <button className="primary small" onClick={save}>
              保存为基线
            </button>
          </div>

          {baselines.length === 0 ? (
            <div className="baseline-empty">
              尚无基线。保存后可把基线时刻的问题与实时结果按稳定身份比较（新增 / 已解决 / 仍存在），正文增删导致的字符偏移变化不会制造新问题。
            </div>
          ) : (
            <div className="baseline-chip-list">
              {baselines.map((b) => (
                <div
                  key={b.id}
                  className={`baseline-chip ${activeBaseline?.id === b.id ? 'active' : ''}`}
                >
                  <button
                    className="baseline-chip-main"
                    title={activeBaseline?.id === b.id ? '退出基线比较' : '与该基线比较实时结果'}
                    onClick={() => onSelect(activeBaseline?.id === b.id ? null : b.id)}
                  >
                    <strong>{b.name}</strong>
                    <span className="baseline-time">{formatTime(b.createdAt)}</span>
                  </button>
                  <button
                    className="danger small"
                    title="删除该基线（不影响正文）"
                    onClick={() => removeBaseline(b)}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- 基线比较视图 ----------

const STATUS_META: Record<IssueDiffStatus, { label: string; cls: string }> = {
  added: { label: '新增', cls: 'bl-added' },
  resolved: { label: '已解决', cls: 'bl-resolved' },
  persisting: { label: '仍存在', cls: 'bl-persisting' },
};

function BaselineCompare({
  baseline,
  live,
  onExit,
}: {
  baseline: IssueBaseline;
  live: Analysis;
  onExit: () => void;
}) {
  const baselineAnalysis = useMemo(() => analyzeIssueBaseline(baseline), [baseline]);
  const diff: IssueBaselineDiff = useMemo(
    () => diffIssueBaseline(baselineAnalysis, live),
    [baselineAnalysis, live],
  );
  const [statusFilter, setStatusFilter] = useState<IssueDiffStatus | 'all'>('all');

  const ordered: IssueDiffEntry[] = useMemo(() => {
    const list =
      statusFilter === 'all'
        ? [...diff.added, ...diff.resolved, ...diff.persisting]
        : diff[statusFilter];
    return list;
  }, [diff, statusFilter]);

  return (
    <>
      <div className="baseline-compare-head">
        <div className="baseline-compare-title">
          与基线「<strong>{baseline.name}</strong>」比较
          <button className="link-btn subtle" onClick={onExit}>
            ✕ 退出比较
          </button>
        </div>
        <div className="baseline-status-filters">
          <button
            className={statusFilter === 'all' ? 'active' : ''}
            onClick={() => setStatusFilter('all')}
          >
            全部 {diff.counts.added + diff.counts.resolved + diff.counts.persisting}
          </button>
          <button
            className={`${STATUS_META.added.cls} ${statusFilter === 'added' ? 'active' : ''}`}
            disabled={diff.counts.added === 0}
            onClick={() => setStatusFilter('added')}
          >
            {STATUS_META.added.label} {diff.counts.added}
          </button>
          <button
            className={`${STATUS_META.resolved.cls} ${statusFilter === 'resolved' ? 'active' : ''}`}
            disabled={diff.counts.resolved === 0}
            onClick={() => setStatusFilter('resolved')}
          >
            {STATUS_META.resolved.label} {diff.counts.resolved}
          </button>
          <button
            className={`${STATUS_META.persisting.cls} ${statusFilter === 'persisting' ? 'active' : ''}`}
            disabled={diff.counts.persisting === 0}
            onClick={() => setStatusFilter('persisting')}
          >
            {STATUS_META.persisting.label} {diff.counts.persisting}
          </button>
        </div>
      </div>

      <div className="issue-list baseline-diff-list">
        {ordered.length === 0 && (
          <div className="empty-hint">
            {diff.counts.added + diff.counts.resolved === 0
              ? `✓ 与基线「${baseline.name}」相比没有新增或已解决问题，${diff.counts.persisting} 个问题仍存在。`
              : '该类别下暂无问题。'}
          </div>
        )}
        {ordered.map((entry) =>
          entry.status === 'resolved' ? (
            <ResolvedIssueRow
              key={entry.identity}
              entry={entry}
              baselineAnalysis={baselineAnalysis}
            />
          ) : (
            <CurrentIssueRow
              key={entry.identity}
              entry={entry}
              baselineAnalysis={baselineAnalysis}
            />
          ),
        )}
      </div>

      <div className="panel-footer">
        问题按「类型 + 源节点稳定 ID + 引用原文 + 同文序次」对齐（循环以排序后的稳定节点 ID 集合标识）；点击任意行可跳到现存源句，源节点已删除的已解决问题不可跳转。
      </div>
    </>
  );
}

/** 新增 / 仍存在：复用实时问题行，顶部加比较状态与基线定位 */
function CurrentIssueRow({
  entry,
  baselineAnalysis,
}: {
  entry: IssueDiffEntry;
  baselineAnalysis: Analysis;
}) {
  const { store } = useApp();
  const { analysis } = store.getSnapshot();
  const issue = entry.current!;
  const meta = STATUS_META[entry.status];
  const currentLabel = labelOfNode(analysis, issue.sourceNodeId);
  const baselineLabel = entry.baseline
    ? labelOfNode(baselineAnalysis, entry.baseline.sourceNodeId)
    : '';

  return (
    <div className={`baseline-diff-wrap ${meta.cls}`}>
      <div className="baseline-diff-banner">
        <span className={`bl-badge ${meta.cls}`}>{meta.label}</span>
        <span className="bl-location">
          {entry.status === 'persisting' && baselineLabel && baselineLabel !== currentLabel ? (
            <>
              基线定位 {baselineLabel} <span className="move-arrow">→</span> 当前 {currentLabel}
            </>
          ) : (
            <>当前定位 {currentLabel}</>
          )}
        </span>
      </div>
      <IssueRow issue={issue} />
    </div>
  );
}

/** 已解决：行内信息取自基线分析；点击按重定位结果跳到现存源句 */
function ResolvedIssueRow({
  entry,
  baselineAnalysis,
}: {
  entry: IssueDiffEntry;
  baselineAnalysis: Analysis;
}) {
  const { highlighter } = useApp();
  const issue = entry.baseline!;
  const meta = TYPE_META[issue.type];
  const sourceNode = baselineAnalysis.nodes[issue.sourceNodeId];
  const sentenceText = sourceNode
    ? sourceNode.text.slice(issue.sentenceStart, issue.sentenceEnd).trim()
    : '';
  const baselineLabel = labelOfNode(baselineAnalysis, issue.sourceNodeId);
  const canJump = Boolean(entry.jump);

  const jump = () => {
    if (!entry.jump) return;
    highlighter.jumpTo(
      entry.jump.nodeId,
      { start: entry.jump.start, end: entry.jump.end },
      entry.jump.refKey,
    );
  };

  return (
    <div className={`baseline-diff-wrap bl-resolved`}>
      <div className="baseline-diff-banner">
        <span className="bl-badge bl-resolved">已解决</span>
        <span className="bl-location">基线定位 {baselineLabel}</span>
        {canJump ? (
          <button className="link-btn bl-jump" onClick={jump}>
            → 查看现存源句
          </button>
        ) : (
          <span className="bl-gone" title="基线中的源节点已从当前文档删除">
            源节点已删除，不可跳转
          </span>
        )}
      </div>
      <div className={`issue-row ${meta.cls} is-resolved-row ${canJump ? '' : 'is-gone'}`}>
        <div className="issue-row-head">
          <span className="issue-type-tag">
            {meta.icon} {meta.label}
          </span>
          <span className="issue-source-label">{baselineLabel}（基线）</span>
        </div>
        {canJump ? (
          <button className="issue-sentence" onClick={jump} title="跳到现存源句">
            “{sentenceText.length > 60 ? sentenceText.slice(0, 60) + '…' : sentenceText}”
          </button>
        ) : (
          <div className="issue-sentence is-static">
            “{sentenceText.length > 60 ? sentenceText.slice(0, 60) + '…' : sentenceText}”
          </div>
        )}
        <div className="issue-message">{issue.message}</div>
        {issue.cycleNodeIds && (
          <div className="cycle-chain">
            {issue.cycleNodeIds.map((id, i) => (
              <span key={id}>
                {labelOfNode(baselineAnalysis, id)}
                {i < issue.cycleNodeIds!.length - 1 ? ' → ' : ''}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  const { store, highlighter } = useApp();
  const { analysis } = store.getSnapshot();
  const meta = TYPE_META[issue.type];
  const sourceNode = analysis.nodes[issue.sourceNodeId];
  const refOcc: RefOccurrence | undefined = issue.refKey
    ? analysis.occurrences.find((o) => o.key === issue.refKey)
    : undefined;

  const sentenceText = sourceNode
    ? sourceNode.text.slice(issue.sentenceStart, issue.sentenceEnd).trim()
    : '';

  const jumpSource = () => {
    highlighter.jumpTo(
      issue.sourceNodeId,
      { start: issue.sentenceStart, end: issue.sentenceEnd },
      issue.refKey,
    );
  };
  const jumpTarget = () => {
    if (issue.targetNodeId) highlighter.jumpTo(issue.targetNodeId);
  };

  return (
    <div className={`issue-row ${meta.cls} ${issue.confirmedTargetId ? 'is-confirmed' : ''}`}>
      <div className="issue-row-head">
        <span className="issue-type-tag">
          {meta.icon} {issue.confirmedTargetId ? `${meta.label}（已确认）` : meta.label}
        </span>
        <span className="issue-source-label">
          {labelOfNode(analysis, issue.sourceNodeId)}
        </span>
      </div>
      <button className="issue-sentence" onClick={jumpSource} title="跳到源句">
        “{sentenceText.length > 60 ? sentenceText.slice(0, 60) + '…' : sentenceText}”
      </button>
      <div className="issue-message">{issue.message}</div>

      {(issue.resolvedTargetIds?.length || issue.missingTargets?.length) && (
        <div className="combined-targets">
          {issue.resolvedTargetIds && issue.resolvedTargetIds.length > 0 && (
            <div className="combined-line">
              <span className="combined-tag">已解析：</span>
              {issue.resolvedTargetIds.map((id) => (
                <button
                  key={id}
                  className="link-btn"
                  onClick={() => highlighter.jumpTo(id)}
                >
                  {labelOfNode(analysis, id)}
                </button>
              ))}
            </div>
          )}
          {issue.missingTargets && issue.missingTargets.length > 0 && (
            <div className="combined-line">
              <span className="combined-tag">缺失：</span>
              {issue.missingTargets.map((m, i) => (
                <span key={`${m.raw}-${i}`} className="missing-target" title={m.reason}>
                  {m.raw}（{m.reason}）
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {issue.type === 'ambiguous' && refOcc && (
        <CandidatePicker occurrence={refOcc} />
      )}

      {issue.targetNodeId && issue.type !== 'ambiguous' && (
        <button className="link-btn" onClick={jumpTarget}>
          → 定位目标：{labelOfNode(analysis, issue.targetNodeId)}
        </button>
      )}
      {issue.cycleNodeIds && (
        <div className="cycle-chain">
          {issue.cycleNodeIds.map((id, i) => (
            <span key={id}>
              <button className="link-btn" onClick={() => highlighter.jumpTo(id)}>
                {labelOfNode(analysis, id)}
              </button>
              {i < issue.cycleNodeIds!.length - 1 ? ' → ' : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CandidatePicker({ occurrence }: { occurrence: RefOccurrence }) {
  const { store, highlighter } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { analysis, confirmed } = store.getSnapshot();
  const candidates =
    occurrence.resolution.candidates ?? occurrence.resolution.ambiguity?.candidates ?? [];
  const chosen =
    occurrence.resolution.ambiguity
      ? occurrence.resolution.targetId
      : confirmed[occurrence.signature];

  return (
    <div className="candidate-box">
      <div className="candidate-title">
        {chosen
          ? `已确认目标为 ${chosen ? labelOfNode(analysis, chosen) : ''}，可撤销后重新选择：`
          : `存在 ${candidates.length} 个候选，系统不会自动改写，请确认目标：`}
      </div>
      {candidates.map((id) => (
        <label key={id} className={`candidate-item ${chosen === id ? 'chosen' : ''}`}>
          <input
            type="radio"
            name={`cand-${occurrence.key}`}
            checked={chosen === id}
            onChange={() => store.confirmAmbiguous(occurrence.signature, id)}
          />
          <button
            type="button"
            className="link-btn"
            onClick={(e) => {
              e.preventDefault();
              highlighter.jumpTo(id);
            }}
          >
            {labelOfNode(analysis, id)}
          </button>
        </label>
      ))}
      {chosen && (
        <div className="candidate-actions">
          <button
            className="link-btn"
            onClick={() => highlighter.jumpTo(chosen)}
          >
            → 跳到已确认目标
          </button>
          <button
            className="link-btn subtle"
            onClick={() => store.clearConfirmation(occurrence.signature)}
          >
            撤销确认（恢复为歧义）
          </button>
        </div>
      )}
    </div>
  );
}
