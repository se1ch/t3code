import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  SourceControlChangeRequestDetailResult,
  SourceControlChangeRequestListItem,
  SourceControlRepositoryError,
  type SourceControlChangeRequestDetailInput,
  type SourceControlChangeRequestChecksStatus,
  type SourceControlChangeRequestListInput,
  type SourceControlChangeRequestListResult,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlCloneProtocol,
  type SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
    readonly publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Effect.Effect<SourceControlPublishRepositoryResult, SourceControlRepositoryError>;
    readonly listChangeRequests: (
      input: SourceControlChangeRequestListInput,
    ) => Effect.Effect<SourceControlChangeRequestListResult, SourceControlRepositoryError>;
    readonly getChangeRequest: (
      input: SourceControlChangeRequestDetailInput,
    ) => Effect.Effect<SourceControlChangeRequestDetailResult, SourceControlRepositoryError>;
  }
>()("t3/sourceControl/SourceControlRepositoryService") {}

const GitHubPullRequestInboxAuthorSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubPullRequestInboxItemSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  author: Schema.optional(Schema.NullOr(GitHubPullRequestInboxAuthorSchema)),
  baseRefName: Schema.String,
  headRefName: Schema.String,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.Boolean),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  statusCheckRollup: Schema.optional(Schema.Array(Schema.Unknown)),
});

const decodeGitHubPullRequestInboxList = decodeJsonResult(
  Schema.Array(GitHubPullRequestInboxItemSchema),
);

const GitHubPullRequestTimelineAuthorSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubPullRequestCommentSchema = Schema.Struct({
  author: Schema.optional(Schema.NullOr(GitHubPullRequestTimelineAuthorSchema)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubPullRequestReviewSchema = Schema.Struct({
  author: Schema.optional(Schema.NullOr(GitHubPullRequestTimelineAuthorSchema)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  submittedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubPullRequestDetailSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  author: Schema.optional(Schema.NullOr(GitHubPullRequestInboxAuthorSchema)),
  baseRefName: Schema.String,
  headRefName: Schema.String,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.Boolean),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  statusCheckRollup: Schema.optional(Schema.Array(Schema.Unknown)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  comments: Schema.optional(Schema.Array(GitHubPullRequestCommentSchema)),
  reviews: Schema.optional(Schema.Array(GitHubPullRequestReviewSchema)),
});

const decodeGitHubPullRequestDetail = decodeJsonResult(GitHubPullRequestDetailSchema);

const GitHubRepositoryViewSchema = Schema.Struct({
  nameWithOwner: Schema.String,
});

const decodeGitHubRepositoryView = decodeJsonResult(GitHubRepositoryViewSchema);

const GitHubPullRequestReviewCommentUserSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubPullRequestReviewCommentSchema = Schema.Struct({
  user: Schema.optional(Schema.NullOr(GitHubPullRequestReviewCommentUserSchema)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  line: Schema.optional(Schema.NullOr(Schema.Number)),
  original_line: Schema.optional(Schema.NullOr(Schema.Number)),
  diff_hunk: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeGitHubPullRequestReviewComments = decodeJsonResult(
  Schema.Array(GitHubPullRequestReviewCommentSchema),
);

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : new SourceControlRepositoryError({
          operation,
          provider,
          detail: "The source control operation could not be completed.",
          cause,
        }),
  );
}

function toRepositoryInfo(
  provider: SourceControlProviderKind,
  urls: SourceControlRepositoryCloneUrls,
): SourceControlRepositoryInfo {
  return {
    provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
  };
}

function selectRemoteUrl(
  urls: SourceControlRepositoryCloneUrls,
  protocol: SourceControlCloneProtocol | undefined,
): string {
  switch (protocol ?? "auto") {
    case "https":
      return urls.url;
    case "ssh":
    case "auto":
      return urls.sshUrl;
  }
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeChangeRequestState(input: {
  readonly state?: string | null | undefined;
  readonly mergedAt?: string | null | undefined;
}) {
  const normalized = input.state?.trim().toUpperCase();
  if ((input.mergedAt?.trim().length ?? 0) > 0 || normalized === "MERGED") {
    return "merged" as const;
  }
  if (normalized === "CLOSED") {
    return "closed" as const;
  }
  return "open" as const;
}

function readRecordString(record: unknown, key: string): string | null {
  if (record === null || typeof record !== "object") {
    return null;
  }
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function normalizeGitHubChecksStatus(
  rollup: ReadonlyArray<unknown> | undefined,
): SourceControlChangeRequestChecksStatus {
  if (!rollup || rollup.length === 0) {
    return "unknown";
  }

  let sawPending = false;
  let sawPassing = false;
  for (const entry of rollup) {
    const conclusion = readRecordString(entry, "conclusion")?.trim().toUpperCase();
    const status = readRecordString(entry, "status")?.trim().toUpperCase();
    const state = readRecordString(entry, "state")?.trim().toUpperCase();
    const value = conclusion || status || state;

    if (
      value === "FAILURE" ||
      value === "FAILED" ||
      value === "ERROR" ||
      value === "TIMED_OUT" ||
      value === "CANCELLED" ||
      value === "ACTION_REQUIRED"
    ) {
      return "failing";
    }
    if (
      value === "PENDING" ||
      value === "QUEUED" ||
      value === "REQUESTED" ||
      value === "WAITING" ||
      value === "IN_PROGRESS" ||
      value === "EXPECTED"
    ) {
      sawPending = true;
    }
    if (value === "SUCCESS" || value === "SKIPPED" || value === "NEUTRAL") {
      sawPassing = true;
    }
  }

  if (sawPending) {
    return "pending";
  }
  return sawPassing ? "passing" : "unknown";
}

function normalizeGitHubPullRequestInboxItem(
  raw: Schema.Schema.Type<typeof GitHubPullRequestInboxItemSchema>,
): SourceControlChangeRequestListItem {
  return Schema.decodeUnknownSync(SourceControlChangeRequestListItem)({
    provider: "github",
    number: raw.number,
    title: raw.title,
    url: raw.url,
    authorLogin: trimToNull(raw.author?.login),
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    state: normalizeChangeRequestState(raw),
    isDraft: raw.isDraft ?? false,
    reviewDecision: trimToNull(raw.reviewDecision),
    checksStatus: normalizeGitHubChecksStatus(raw.statusCheckRollup),
    updatedAt: trimToNull(raw.updatedAt),
  });
}

function fallbackGitHubPullRequestItem(number: number): SourceControlChangeRequestListItem {
  return Schema.decodeUnknownSync(SourceControlChangeRequestListItem)({
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
  });
}

function compareNullableIsoDates(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return Date.parse(left) - Date.parse(right);
}

function positiveIntOrNull(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const integer = Math.trunc(value);
  return integer > 0 ? integer : null;
}

function normalizeGitHubPullRequestDetail(
  raw: Schema.Schema.Type<typeof GitHubPullRequestDetailSchema>,
  inlineComments: ReadonlyArray<Schema.Schema.Type<typeof GitHubPullRequestReviewCommentSchema>>,
): SourceControlChangeRequestDetailResult {
  const timeline = [
    ...(raw.comments ?? []).map((comment) => ({
      kind: "comment" as const,
      authorLogin: trimToNull(comment.author?.login),
      body: comment.body ?? "",
      url: trimToNull(comment.url),
      state: null,
      createdAt: trimToNull(comment.createdAt),
    })),
    ...(raw.reviews ?? []).map((review) => ({
      kind: "review" as const,
      authorLogin: trimToNull(review.author?.login),
      body: review.body ?? "",
      url: trimToNull(review.url),
      state: trimToNull(review.state),
      createdAt: trimToNull(review.submittedAt),
    })),
    ...inlineComments.map((comment) => ({
      kind: "inline-comment" as const,
      authorLogin: trimToNull(comment.user?.login),
      body: comment.body ?? "",
      url: trimToNull(comment.html_url),
      state: null,
      createdAt: trimToNull(comment.created_at),
      path: trimToNull(comment.path),
      line: positiveIntOrNull(comment.line),
      originalLine: positiveIntOrNull(comment.original_line),
      diffHunk: comment.diff_hunk ?? null,
    })),
  ].sort((left, right) => compareNullableIsoDates(left.createdAt, right.createdAt));

  return Schema.decodeUnknownSync(SourceControlChangeRequestDetailResult)({
    item: normalizeGitHubPullRequestInboxItem(raw),
    body: raw.body ?? null,
    timeline,
  });
}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const github = yield* GitHubCli.GitHubCli;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const ensureConcreteProvider = (input: {
    readonly operation: string;
    readonly provider: SourceControlProviderKind;
  }) => {
    if (input.provider !== "unknown") {
      return Effect.succeed(input.provider);
    }

    return Effect.fail(
      new SourceControlRepositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a source control provider before continuing.",
      }),
    );
  };

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(function* (
    input: SourceControlRepositoryLookupInput,
  ) {
    const providerKind = yield* ensureConcreteProvider({
      operation: "lookupRepository",
      provider: input.provider,
    });
    const provider = yield* providers.get(providerKind);
    const urls = yield* provider.getRepositoryCloneUrls({
      cwd: input.cwd ?? config.cwd,
      repository: input.repository.trim(),
    });
    return toRepositoryInfo(providerKind, urls);
  });

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: "unknown",
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePath(trimmed, path));
    },
  );

  const prepareDestination = Effect.fn("SourceControlRepositoryService.prepareDestination")(
    function* (destinationPath: string) {
      const normalizedDestination = yield* normalizeDestinationPath(destinationPath);
      if (yield* fileSystem.exists(normalizedDestination)) {
        const entries = yield* fileSystem
          .readDirectory(normalizedDestination, { recursive: false })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: "unknown",
                  detail: "Destination path already exists and is not a directory.",
                  cause,
                }),
            ),
          );
        if (entries.length > 0) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: "unknown",
            detail: "Destination path already exists and is not empty.",
          });
        }
      } else {
        yield* fileSystem.makeDirectory(path.dirname(normalizedDestination), { recursive: true });
      }

      return {
        destinationPath: normalizedDestination,
        parentPath: path.dirname(normalizedDestination),
        directoryName: path.basename(normalizedDestination),
      };
    },
  );

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
  ) {
    const preparedDestination = yield* prepareDestination(input.destinationPath);
    let repository: SourceControlRepositoryInfo | null = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;
    let provider: SourceControlProviderKind = input.provider ?? "unknown";

    if (input.provider && input.repository) {
      repository = yield* lookupRepository({
        provider: input.provider,
        repository: input.repository,
        cwd: preparedDestination.parentPath,
      });
      remoteUrl = selectRemoteUrl(repository, input.protocol);
      provider = input.provider;
    }

    if (!remoteUrl) {
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }

    yield* git.execute({
      operation: "SourceControlRepositoryService.cloneRepository",
      cwd: preparedDestination.parentPath,
      args: ["clone", remoteUrl, preparedDestination.directoryName],
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024,
    });

    return {
      cwd: preparedDestination.destinationPath,
      remoteUrl,
      repository,
    };
  });

  const publishRepository = Effect.fn("SourceControlRepositoryService.publishRepository")(
    function* (input: SourceControlPublishRepositoryInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "publishRepository",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      const urls = yield* provider.createRepository({
        cwd: input.cwd,
        repository: input.repository.trim(),
        visibility: input.visibility,
      });
      const remoteUrl = selectRemoteUrl(urls, input.protocol);
      const remoteName = yield* git.ensureRemote({
        cwd: input.cwd,
        preferredName: input.remoteName?.trim() || "origin",
        url: remoteUrl,
      });

      // An empty local repo (no commits) would make `git push HEAD:...` fail
      // with an opaque "src refspec HEAD does not match any". Treat this as a
      // partial success: the remote was created and wired up, but there is
      // nothing to push yet.
      const hasCommits = yield* git
        .execute({
          operation: "SourceControlRepositoryService.publishRepository.headCheck",
          cwd: input.cwd,
          args: ["rev-parse", "--verify", "HEAD"],
        })
        .pipe(
          Effect.map(() => true),
          Effect.orElseSucceed(() => false),
        );
      if (!hasCommits) {
        const details = yield* git.statusDetails(input.cwd).pipe(Effect.orElseSucceed(() => null));
        return {
          repository: toRepositoryInfo(providerKind, urls),
          remoteName,
          remoteUrl,
          branch: details?.branch ?? "main",
          status: "remote_added" as const,
        };
      }

      const pushResult = yield* git.pushCurrentBranch(input.cwd, null, { remoteName });

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl,
        branch: pushResult.branch,
        ...(pushResult.upstreamBranch ? { upstreamBranch: pushResult.upstreamBranch } : {}),
        status: "pushed" as const,
      };
    },
  );

  const listChangeRequests = Effect.fn("SourceControlRepositoryService.listChangeRequests")(
    function* (input: SourceControlChangeRequestListInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "listChangeRequests",
        provider: input.provider,
      });
      if (providerKind !== "github") {
        return yield* new SourceControlRepositoryError({
          operation: "listChangeRequests",
          provider: providerKind,
          detail: "Pull request management currently supports GitHub repositories.",
        });
      }

      const state = input.state ?? "open";
      const result = yield* github.execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--state",
          state,
          "--limit",
          String(input.limit ?? 50),
          "--json",
          "number,title,url,author,baseRefName,headRefName,state,mergedAt,isDraft,reviewDecision,updatedAt,statusCheckRollup",
        ],
      });
      const raw = result.stdout.trim();
      if (raw.length === 0) {
        return { items: [] };
      }

      const decoded = decodeGitHubPullRequestInboxList(raw);
      if (!Result.isSuccess(decoded)) {
        return yield* new SourceControlRepositoryError({
          operation: "listChangeRequests",
          provider: providerKind,
          detail: "GitHub CLI returned invalid pull request list JSON.",
          cause: decoded.failure,
        });
      }

      return {
        items: decoded.success.map(normalizeGitHubPullRequestInboxItem),
      };
    },
  );

  const getChangeRequest = Effect.fn("SourceControlRepositoryService.getChangeRequest")(function* (
    input: SourceControlChangeRequestDetailInput,
  ) {
    const providerKind = yield* ensureConcreteProvider({
      operation: "getChangeRequest",
      provider: input.provider,
    });
    if (providerKind !== "github") {
      return yield* new SourceControlRepositoryError({
        operation: "getChangeRequest",
        provider: providerKind,
        detail: "Pull request management currently supports GitHub repositories.",
      });
    }

    const result = yield* github.execute({
      cwd: input.cwd,
      args: [
        "pr",
        "view",
        String(input.number),
        "--json",
        "number,title,url,author,baseRefName,headRefName,state,mergedAt,isDraft,reviewDecision,updatedAt,statusCheckRollup,body,comments,reviews",
      ],
    });
    const repositoryResult = yield* github.execute({
      cwd: input.cwd,
      args: ["repo", "view", "--json", "nameWithOwner"],
    });
    const raw = result.stdout.trim();
    const repositoryRaw = repositoryResult.stdout.trim();
    if (raw.length === 0) {
      return {
        item: fallbackGitHubPullRequestItem(input.number),
        body: null,
        timeline: [],
      };
    }

    const decoded = decodeGitHubPullRequestDetail(raw);
    if (!Result.isSuccess(decoded)) {
      return yield* new SourceControlRepositoryError({
        operation: "getChangeRequest",
        provider: providerKind,
        detail: "GitHub CLI returned invalid pull request detail JSON.",
        cause: decoded.failure,
      });
    }

    const decodedRepository = decodeGitHubRepositoryView(repositoryRaw);
    if (!Result.isSuccess(decodedRepository)) {
      return yield* new SourceControlRepositoryError({
        operation: "getChangeRequest",
        provider: providerKind,
        detail: "GitHub CLI returned invalid repository JSON.",
        cause: decodedRepository.failure,
      });
    }

    const inlineCommentsResult = yield* github.execute({
      cwd: input.cwd,
      args: [
        "api",
        `repos/${decodedRepository.success.nameWithOwner}/pulls/${input.number}/comments?per_page=100`,
      ],
    });
    const inlineCommentsRaw = inlineCommentsResult.stdout.trim();
    const decodedInlineComments = decodeGitHubPullRequestReviewComments(
      inlineCommentsRaw.length > 0 ? inlineCommentsRaw : "[]",
    );
    if (!Result.isSuccess(decodedInlineComments)) {
      return yield* new SourceControlRepositoryError({
        operation: "getChangeRequest",
        provider: providerKind,
        detail: "GitHub CLI returned invalid pull request review comment JSON.",
        cause: decodedInlineComments.failure,
      });
    }

    return normalizeGitHubPullRequestDetail(decoded.success, decodedInlineComments.success);
  });

  return SourceControlRepositoryService.of({
    lookupRepository: (input) =>
      lookupRepository(input).pipe(mapRepositoryError("lookupRepository", input.provider)),
    cloneRepository: (input) =>
      cloneRepository(input).pipe(
        mapRepositoryError("cloneRepository", input.provider ?? "unknown"),
      ),
    publishRepository: (input) =>
      publishRepository(input).pipe(mapRepositoryError("publishRepository", input.provider)),
    listChangeRequests: (input) =>
      listChangeRequests(input).pipe(mapRepositoryError("listChangeRequests", input.provider)),
    getChangeRequest: (input) =>
      getChangeRequest(input).pipe(mapRepositoryError("getChangeRequest", input.provider)),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
