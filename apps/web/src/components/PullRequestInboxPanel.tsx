import type {
  EnvironmentId,
  SourceControlChangeRequestDetailResult,
  ScopedThreadRef,
  SourceControlChangeRequestListItem,
  SourceControlChangeRequestTimelineEntry,
} from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  Clock3Icon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  RefreshCcwIcon,
  XCircleIcon,
  XIcon,
} from "lucide-react";

import { openPullRequestLink } from "~/lib/openPullRequestLink";
import { parseGitHubPullRequestNumber } from "~/lib/githubPullRequestLinks";
import { usePreparePullRequestThreadAction } from "~/lib/sourceControlActions";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useEnvironmentQuery } from "~/state/query";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { Button } from "./ui/button";
import ChatMarkdown from "./ChatMarkdown";
import { ScrollArea } from "./ui/scroll-area";
import { Spinner } from "./ui/spinner";
import { stackedThreadToast, toastManager } from "./ui/toast";

interface PullRequestInboxPanelProps {
  environmentId: EnvironmentId;
  cwd: string | null;
  activeThreadRef: ScopedThreadRef;
  selectedNumber: number | null;
  revealRequestId: number;
  onPrepared: (input: { branch: string; worktreePath: string | null }) => void | Promise<void>;
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return "No update time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatReviewDecision(value: string | null): string {
  switch (value) {
    case "APPROVED":
      return "Approved";
    case "CHANGES_REQUESTED":
      return "Changes requested";
    case "REVIEW_REQUIRED":
      return "Needs review";
    default:
      return "No review";
  }
}

function checksTone(item: SourceControlChangeRequestListItem) {
  switch (item.checksStatus) {
    case "passing":
      return {
        label: "Checks passing",
        className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        Icon: CheckCircle2Icon,
      };
    case "failing":
      return {
        label: "Checks failing",
        className: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
        Icon: XCircleIcon,
      };
    case "pending":
      return {
        label: "Checks pending",
        className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        Icon: Clock3Icon,
      };
    case "unknown":
      return {
        label: "Checks unknown",
        className: "bg-muted text-muted-foreground",
        Icon: CircleDotIcon,
      };
  }
}

function reviewTone(value: string | null): string {
  switch (value) {
    case "APPROVED":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "CHANGES_REQUESTED":
      return "bg-rose-500/10 text-rose-700 dark:text-rose-300";
    case "REVIEW_REQUIRED":
      return "bg-sky-500/10 text-sky-700 dark:text-sky-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function formatTimelineEntryKind(entry: SourceControlChangeRequestTimelineEntry): string {
  if (entry.kind === "inline-comment") {
    return "Inline review";
  }
  if (entry.kind === "comment") {
    return "Comment";
  }
  switch (entry.state) {
    case "APPROVED":
      return "Approved";
    case "CHANGES_REQUESTED":
      return "Changes requested";
    case "COMMENTED":
      return "Review comment";
    default:
      return "Review";
  }
}

function formatInlineLocation(entry: SourceControlChangeRequestTimelineEntry): string | null {
  if (entry.kind !== "inline-comment" || !entry.path) {
    return null;
  }
  const line = entry.line ?? entry.originalLine ?? null;
  return line ? `${entry.path}:${line}` : entry.path;
}

function fallbackPullRequestItem(number: number): SourceControlChangeRequestListItem {
  return {
    provider: "github",
    number,
    title: `Pull request #${number}`,
    url: `https://github.com/pull/${number}`,
    authorLogin: null,
    baseRefName: "unknown",
    headRefName: "unknown",
    state: "open",
    isDraft: false,
    reviewDecision: null,
    checksStatus: "unknown",
    updatedAt: null,
  };
}

function PullRequestListRow(props: {
  item: SourceControlChangeRequestListItem;
  selected: boolean;
  onSelect: (item: SourceControlChangeRequestListItem) => void;
}) {
  const checks = checksTone(props.item);
  const ChecksIcon = checks.Icon;
  return (
    <button
      type="button"
      onClick={() => props.onSelect(props.item)}
      className={cn(
        "min-w-0 w-full overflow-hidden rounded-lg border p-3 text-left transition",
        props.selected
          ? "border-primary/45 bg-primary/5 text-foreground shadow-sm"
          : "border-border/70 bg-background/70 hover:border-border hover:bg-accent/50",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <GitPullRequestIcon className="size-4 shrink-0 text-muted-foreground" />
            <p className="line-clamp-2 min-w-0 break-words text-sm font-medium leading-5 text-foreground">
              {props.item.title}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
            <span>#{props.item.number}</span>
            {props.item.authorLogin ? <span>by {props.item.authorLogin}</span> : null}
            <span>{formatUpdatedAt(props.item.updatedAt)}</span>
          </div>
        </div>
        {props.item.isDraft ? (
          <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-muted-foreground text-xs">
            Draft
          </span>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs",
            checks.className,
          )}
        >
          <ChecksIcon className="size-3.5" />
          {checks.label}
        </span>
        <span
          className={cn(
            "inline-flex items-center rounded-md px-2 py-1 text-xs",
            reviewTone(props.item.reviewDecision),
          )}
        >
          {formatReviewDecision(props.item.reviewDecision)}
        </span>
      </div>
    </button>
  );
}

function PullRequestDetail(props: {
  item: SourceControlChangeRequestListItem | null;
  detail: SourceControlChangeRequestDetailResult | null;
  detailPending: boolean;
  detailError: string | null;
  cwd: string;
  threadRef: ScopedThreadRef;
  onPullRequestLinkClick: (href: string) => boolean;
  busy: boolean;
  checkoutNumber: number | null;
  onClose: () => void;
  onOpen: (item: SourceControlChangeRequestListItem) => void;
  onCheckout: (item: SourceControlChangeRequestListItem) => void;
}) {
  if (!props.item) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border/70 bg-card/30 p-6 text-muted-foreground text-sm">
        Select a pull request.
      </div>
    );
  }

  const checks = checksTone(props.item);
  const ChecksIcon = checks.Icon;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-border/70 bg-card/30">
      <div className="border-b border-border/70 p-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="@4xl/pr-inbox:hidden -ml-1 shrink-0"
              title="Back to pull requests"
              aria-label="Back to pull requests"
              onClick={props.onClose}
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-2 text-muted-foreground text-xs">
                <GitPullRequestIcon className="size-3.5" />
                <span>#{props.item.number}</span>
                {props.item.authorLogin ? <span>by {props.item.authorLogin}</span> : null}
                {props.item.isDraft ? <span>Draft</span> : null}
              </div>
              <h3 className="text-balance text-sm font-semibold leading-5 text-foreground">
                {props.item.title}
              </h3>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="Open pull request"
              aria-label={`Open pull request #${props.item.number}`}
              onClick={() => props.onOpen(props.item!)}
            >
              <ExternalLinkIcon className="size-4" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="hidden @4xl/pr-inbox:inline-flex"
              title="Close details"
              aria-label="Close pull request details"
              onClick={props.onClose}
            >
              <XIcon className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          <div className="grid gap-2 text-xs @3xl/pr-inbox:grid-cols-2">
            <div className="rounded-md bg-background/70 p-3">
              <p className="text-muted-foreground">Branches</p>
              <div className="mt-1 flex min-w-0 items-center gap-1.5 text-foreground">
                <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{props.item.headRefName}</span>
                <span className="text-muted-foreground">to</span>
                <span className="min-w-0 truncate">{props.item.baseRefName}</span>
              </div>
            </div>
            <div className="rounded-md bg-background/70 p-3">
              <p className="text-muted-foreground">Updated</p>
              <p className="mt-1 text-foreground">{formatUpdatedAt(props.item.updatedAt)}</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs",
                checks.className,
              )}
            >
              <ChecksIcon className="size-3.5" />
              {checks.label}
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-md px-2 py-1 text-xs",
                reviewTone(props.item.reviewDecision),
              )}
            >
              {formatReviewDecision(props.item.reviewDecision)}
            </span>
          </div>

          {props.detailError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive text-xs">
              {props.detailError}
            </div>
          ) : props.detailPending ? (
            <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background/70 p-3 text-muted-foreground text-sm">
              <Spinner className="size-4" />
              Loading comments...
            </div>
          ) : props.detail ? (
            <div className="space-y-3">
              {props.detail.body?.trim() ? (
                <div className="rounded-md border border-border/70 bg-background/70 p-3">
                  <div className="mb-2 flex items-center gap-2 text-muted-foreground text-xs">
                    <MessageSquareIcon className="size-3.5" />
                    Description
                  </div>
                  <ChatMarkdown
                    text={props.detail.body}
                    cwd={props.cwd}
                    threadRef={props.threadRef}
                    onLinkClick={({ href }) => props.onPullRequestLinkClick(href)}
                    className="text-xs leading-6"
                  />
                </div>
              ) : null}

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-foreground">Comments</span>
                  <span className="text-muted-foreground">{props.detail.timeline.length}</span>
                </div>
                {props.detail.timeline.length > 0 ? (
                  props.detail.timeline.map((entry, index) => (
                    <div
                      key={`${entry.kind}-${entry.createdAt ?? "unknown"}-${index}`}
                      className="rounded-md border border-border/70 bg-background/70 p-3"
                    >
                      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
                        <span className="font-medium text-foreground">
                          {entry.authorLogin ?? "Unknown"}
                        </span>
                        <span>{formatTimelineEntryKind(entry)}</span>
                        {entry.createdAt ? <span>{formatUpdatedAt(entry.createdAt)}</span> : null}
                        {formatInlineLocation(entry) ? (
                          <span className="max-w-full truncate font-mono">
                            {formatInlineLocation(entry)}
                          </span>
                        ) : null}
                      </div>
                      {entry.diffHunk ? (
                        <pre className="mb-2 max-h-32 overflow-auto rounded border border-border/70 bg-muted/40 p-2 font-mono text-[11px] leading-5 text-muted-foreground">
                          {entry.diffHunk}
                        </pre>
                      ) : null}
                      {entry.body.trim().length > 0 ? (
                        <ChatMarkdown
                          text={entry.body}
                          cwd={props.cwd}
                          threadRef={props.threadRef}
                          onLinkClick={({ href }) => props.onPullRequestLinkClick(href)}
                          className="text-xs leading-6"
                        />
                      ) : (
                        <p className="text-muted-foreground text-sm">No text.</p>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="rounded-md border border-border/70 bg-background/70 p-3 text-muted-foreground text-sm">
                    No comments yet.
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </ScrollArea>

      <div className="flex items-center justify-between gap-3 border-t border-border/70 p-3">
        <div className="min-w-0 text-muted-foreground text-xs">
          {props.checkoutNumber === props.item.number ? "Checking out..." : "Open PR locally"}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.busy}
          onClick={() => props.onCheckout(props.item!)}
        >
          {props.checkoutNumber === props.item.number ? (
            <Spinner className="size-3.5" />
          ) : (
            "Checkout"
          )}
        </Button>
      </div>
    </div>
  );
}

export function PullRequestInboxPanel({
  environmentId,
  cwd,
  activeThreadRef,
  selectedNumber: requestedSelectedNumber,
  revealRequestId,
  onPrepared,
}: PullRequestInboxPanelProps) {
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [checkoutNumber, setCheckoutNumber] = useState<number | null>(null);
  const query = useEnvironmentQuery(
    cwd !== null
      ? sourceControlEnvironment.changeRequests({
          environmentId,
          input: {
            cwd,
            provider: "github",
            state: "open",
            limit: 50,
          },
        })
      : null,
  );
  const sourceControlScope = useMemo(() => ({ environmentId, cwd }), [cwd, environmentId]);
  const preparePullRequestThreadAction = usePreparePullRequestThreadAction(sourceControlScope);
  const items = query.data?.items ?? [];
  const busy = preparePullRequestThreadAction.isPending;
  const selectedListItem =
    selectedNumber !== null ? (items.find((item) => item.number === selectedNumber) ?? null) : null;
  const activeDetailNumber = detailOpen ? selectedNumber : null;
  const detailQuery = useEnvironmentQuery(
    cwd !== null && activeDetailNumber !== null
      ? sourceControlEnvironment.changeRequest({
          environmentId,
          input: {
            cwd,
            provider: "github",
            number: activeDetailNumber,
          },
        })
      : null,
  );

  useEffect(() => {
    if (requestedSelectedNumber === null) {
      return;
    }
    setSelectedNumber(requestedSelectedNumber);
    setDetailOpen(true);
  }, [requestedSelectedNumber, revealRequestId]);
  const selectedItem =
    selectedListItem ??
    detailQuery.data?.item ??
    (activeDetailNumber !== null ? fallbackPullRequestItem(activeDetailNumber) : null);

  const handleOpen = useCallback((item: SourceControlChangeRequestListItem) => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }
    void openPullRequestLink(api.shell, item.url).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, []);

  const handleCheckout = useCallback(
    async (item: SourceControlChangeRequestListItem) => {
      if (!cwd) return;
      setCheckoutNumber(item.number);
      const result = await preparePullRequestThreadAction.run({
        reference: String(item.number),
        mode: "local",
        threadId: activeThreadRef.threadId,
      });
      setCheckoutNumber(null);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          preparePullRequestThreadAction.resetError();
        }
        return;
      }
      await onPrepared({
        branch: result.value.branch,
        worktreePath: result.value.worktreePath,
      });
      toastManager.add({
        type: "success",
        title: `Checked out pull request #${item.number}.`,
      });
    },
    [activeThreadRef.threadId, cwd, onPrepared, preparePullRequestThreadAction],
  );

  const errorMessage =
    query.error ??
    (preparePullRequestThreadAction.error instanceof Error
      ? preparePullRequestThreadAction.error.message
      : preparePullRequestThreadAction.error
        ? "Failed to checkout pull request."
        : null);
  const detailErrorMessage =
    detailOpen && selectedItem !== null && detailQuery.error ? detailQuery.error : null;
  const handleMarkdownLinkClick = useCallback((href: string) => {
    const number = parseGitHubPullRequestNumber(href);
    if (number === null) {
      return false;
    }
    setSelectedNumber(number);
    setDetailOpen(true);
    return true;
  }, []);

  if (!cwd) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-muted-foreground text-sm">
        Open a repository to view pull requests.
      </div>
    );
  }

  return (
    <div className="@container/pr-inbox flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <GitPullRequestIcon className="size-4 text-muted-foreground" />
            <span>Pull requests</span>
          </div>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {query.isPending ? "Refreshing..." : `${items.length} open`}
          </p>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          title="Refresh pull requests"
          aria-label="Refresh pull requests"
          onClick={() => {
            query.refresh();
            if (detailOpen && selectedItem !== null) {
              detailQuery.refresh();
            }
          }}
          disabled={query.isPending || detailQuery.isPending || busy}
        >
          {query.isPending ? <Spinner className="size-4" /> : <RefreshCcwIcon className="size-4" />}
        </Button>
      </div>

      {errorMessage ? (
        <div className="border-b border-border/70 px-4 py-2 text-destructive text-xs">
          {errorMessage}
        </div>
      ) : null}

      <div
        className={cn(
          "grid min-h-0 flex-1 gap-3 p-3",
          detailOpen
            ? "grid-rows-1 @4xl/pr-inbox:grid-cols-[minmax(18rem,0.9fr)_minmax(0,1.35fr)] @4xl/pr-inbox:grid-rows-1"
            : "grid-rows-1",
        )}
      >
        <div
          className={cn(
            "min-w-0 min-h-0 flex-col",
            detailOpen ? "hidden @4xl/pr-inbox:flex" : "flex",
          )}
        >
          <ScrollArea className="min-h-0 flex-1 pr-1">
            {items.length > 0 ? (
              <div className="space-y-2">
                {items.map((item) => (
                  <PullRequestListRow
                    key={item.number}
                    item={item}
                    selected={detailOpen && selectedItem?.number === item.number}
                    onSelect={(nextItem) => {
                      setSelectedNumber(nextItem.number);
                      setDetailOpen(true);
                    }}
                  />
                ))}
              </div>
            ) : query.isPending ? (
              <div className="flex items-center gap-2 py-8 text-muted-foreground text-sm">
                <Spinner className="size-4" />
                Loading pull requests...
              </div>
            ) : (
              <div className="py-8 text-muted-foreground text-sm">No open pull requests.</div>
            )}
          </ScrollArea>
        </div>

        {detailOpen ? (
          <PullRequestDetail
            item={selectedItem}
            detail={detailQuery.data ?? null}
            detailPending={detailQuery.isPending}
            detailError={detailErrorMessage}
            cwd={cwd}
            threadRef={activeThreadRef}
            onPullRequestLinkClick={handleMarkdownLinkClick}
            busy={busy}
            checkoutNumber={checkoutNumber}
            onClose={() => setDetailOpen(false)}
            onOpen={handleOpen}
            onCheckout={(item) => {
              void handleCheckout(item);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
