/**
 * Service desk types and the small visual vocabulary shared by the desk, the ticket page
 * and the client portal. Status and priority are always shown the same way so a colour
 * means one thing everywhere.
 */
import { AlertTriangle, CheckCircle2, Clock, CircleDot, PauseCircle } from 'lucide-react';

export type TicketStatus = 'new' | 'open' | 'pending' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TicketType = 'incident' | 'request' | 'question' | 'problem';
export type SlaTargetState = 'none' | 'on_track' | 'at_risk' | 'breached' | 'met' | 'missed' | 'paused';

export type TicketSummary = {
  id: string;
  number: number;
  ref: string;
  subject: string;
  type: TicketType;
  status: TicketStatus;
  priority: TicketPriority;
  channel: 'workspace' | 'portal' | 'email';
  queueId: string;
  categoryId: string | null;
  requesterId: string;
  clientOrgId: string | null;
  assigneeId: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  version: number;
  sla: {
    pausedSince?: string | null;
    firstResponseDueAt: string | null;
    resolutionDueAt: string | null;
    firstResponse: SlaTargetState;
    resolution: SlaTargetState;
  };
  queueName?: string | null;
  requesterName?: string | null;
  assigneeName?: string | null;
  clientName?: string | null;
  categoryName?: string | null;
};

export type TicketDetail = TicketSummary & {
  description: string;
  firstRespondedAt: string | null;
  closedAt: string | null;
  requesterEmail: string | null;
  task: { id: string; title: string | null; ref: string | null } | null;
  comments: { id: string; authorId: string; authorName: string; fromRequesterSide: boolean; visibility: 'public' | 'internal'; body: string; createdAt: string }[];
  attachments: { fileId: string; name: string; sizeBytes: number; mimeType: string; visibility: 'public' | 'internal'; addedAt: string; addedByName: string }[];
  events: { id: number; kind: string; from: string | null; to: string | null; createdAt: string; actorName: string | null }[];
  feedback: { rating: number; comment: string | null; createdAt: string } | null;
  permissions: { canWork: boolean; seesInternal: boolean; canReply: boolean; canRate: boolean; canClose: boolean; canReopen: boolean };
  form: { key: string; label: string; type: FormField['type']; value: string | number | boolean }[];
  articles: { id: string; title: string; audience: 'internal' | 'public' }[];
  rootCause: string | null;
  workaround: string | null;
  problem: { id: string; ref: string; subject: string; status: TicketStatus } | null;
  incidents: { id: string; ref: string; subject: string; status: TicketStatus }[];
  assets: { id: string; tag: string; name: string; status: string; warrantyUntil: string | null }[];
  changes: { id: string; ref: string; title: string; status: string }[];
};

export type FormField = {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'checkbox';
  required?: boolean;
  options?: string[];
  help?: string;
};

export type Queue = {
  id: string;
  name: string;
  description: string | null;
  audience: 'internal' | 'client';
  isActive: boolean;
  escalationUserId: string | null;
  escalationName: string | null;
  memberCount: number;
  openCount: number;
  isMember: boolean;
  categories: { id: string; name: string; isActive: boolean; formFields: FormField[] }[];
};

export const STATUS_LABEL: Record<TicketStatus, string> = {
  new: 'New', open: 'Open', pending: 'Waiting on requester', resolved: 'Resolved', closed: 'Closed',
};
export const PRIORITY_LABEL: Record<TicketPriority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
export const TYPE_LABEL: Record<TicketType, string> = { incident: 'Incident', request: 'Service request', question: 'Question', problem: 'Problem' };

export function StatusBadge({ status }: { status: TicketStatus }) {
  return <span className={`sd-badge sd-status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return (
    <span className={`sd-priority sd-priority-${priority}`}>
      <span className="sd-priority-bar" aria-hidden="true" />
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

/** The more urgent of the two targets, in words and an icon. */
export function SlaBadge({ ticket }: { ticket: Pick<TicketSummary, 'sla' | 'status'> }) {
  const { firstResponse, resolution } = ticket.sla;
  const done = ticket.status === 'resolved' || ticket.status === 'closed';
  if (!done && (firstResponse === 'paused' || resolution === 'paused') && firstResponse !== 'breached' && resolution !== 'breached') {
    return <span className="sd-sla sd-sla-ok"><PauseCircle size={13} aria-hidden="true" />Paused</span>;
  }
  if (firstResponse === 'breached' || resolution === 'breached') {
    return <span className="sd-sla sd-sla-breached"><AlertTriangle size={13} aria-hidden="true" />Breached</span>;
  }
  if (!done && (firstResponse === 'at_risk' || resolution === 'at_risk')) {
    return <span className="sd-sla sd-sla-risk"><Clock size={13} aria-hidden="true" />Due soon</span>;
  }
  if (done) {
    return resolution === 'missed' || firstResponse === 'missed'
      ? <span className="sd-sla sd-sla-missed"><AlertTriangle size={13} aria-hidden="true" />Missed</span>
      : <span className="sd-sla sd-sla-met"><CheckCircle2 size={13} aria-hidden="true" />Met</span>;
  }
  return <span className="sd-sla sd-sla-ok"><CircleDot size={13} aria-hidden="true" />On track</span>;
}

export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
}

/** "in 3h" / "4h ago", for a due time. */
export function dueIn(value: string | null): string {
  if (!value) return '—';
  const diff = new Date(value).getTime() - Date.now();
  const text = formatMinutes(Math.round(Math.abs(diff) / 60000));
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}
