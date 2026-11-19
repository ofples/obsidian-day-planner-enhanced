import { z } from "zod";

import {
  githubProjectLocation,
  githubRepository,
  type GitHubSelection,
} from "./github-config";
import type { SourceRequest } from "./source-http";
import {
  SourcePageBudget,
  readSourcePages,
  type SourcePageState,
} from "./source-pages";
import type { SourceReadResult } from "./source-session";
import type { TaskMembership } from "./source-types";
import { TaskReadError, type ProviderTask, type TaskSnapshot } from "./types";

const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
const fieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  dataType: z.string(),
  options: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
});
const fieldsSchema = z.object({
  nodes: z.array(fieldSchema.nullable()),
  pageInfo: pageInfoSchema,
});
const repositorySchema = z.object({
  nameWithOwner: z.string(),
  isPrivate: z.boolean(),
});
const graphContentSchema = z.object({
  __typename: z.enum(["Issue", "DraftIssue", "PullRequest"]),
  id: z.string(),
  title: z.string(),
  body: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  url: z.string().optional(),
  number: z.number().int().optional(),
  state: z.string().optional(),
  repository: repositorySchema.optional(),
  labels: z
    .object({ nodes: z.array(z.object({ name: z.string() }).nullable()) })
    .optional(),
  assignees: z
    .object({ nodes: z.array(z.object({ login: z.string() }).nullable()) })
    .optional(),
  milestone: z.object({ dueOn: z.string().nullable() }).nullable().optional(),
});
const fieldValueSchema = z.object({
  __typename: z.string(),
  field: z.object({ id: z.string() }).optional(),
  optionId: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
});
const projectItemSchema = z.object({
  id: z.string(),
  isArchived: z.boolean(),
  content: graphContentSchema.nullable(),
  fieldValues: z.object({
    nodes: z.array(fieldValueSchema.nullable()),
    pageInfo: pageInfoSchema,
  }),
});
const projectSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
});
const projectSchema = projectSummarySchema.extend({
  __typename: z.literal("ProjectV2"),
  fields: fieldsSchema,
  items: z.object({
    nodes: z.array(projectItemSchema.nullable()),
    pageInfo: pageInfoSchema,
  }),
});
const issueSchema = z.object({
  node_id: z.string(),
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  created_at: z.string(),
  updated_at: z.string(),
  labels: z
    .array(z.union([z.string(), z.object({ name: z.string() })]))
    .default([]),
  assignees: z.array(z.object({ login: z.string() })).default([]),
  milestone: z.object({ due_on: z.string().nullable() }).nullable().optional(),
  pull_request: z.unknown().optional(),
  repository: z.object({ private: z.boolean() }).optional(),
});

const projectQuery = `query DayPlannerProject($id: ID!, $first: Int!, $after: String) {
  node(id: $id) { __typename ... on ProjectV2 {
    id title url
    fields(first: 100) { nodes {
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { options { id name } }
    } pageInfo { hasNextPage endCursor } }
    items(first: $first, after: $after) { nodes {
      id isArchived
      fieldValues(first: 100) { nodes { __typename
        ... on ProjectV2ItemFieldSingleSelectValue { optionId name field { ... on ProjectV2SingleSelectField { id } } }
        ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { id } } }
      } pageInfo { hasNextPage endCursor } }
      content { __typename
        ... on Issue { id title body createdAt updatedAt url number state repository { nameWithOwner isPrivate } labels(first:100) { nodes { name } } assignees(first:100) { nodes { login } } milestone { dueOn } }
        ... on PullRequest { id title body createdAt updatedAt url number state repository { nameWithOwner isPrivate } labels(first:100) { nodes { name } } assignees(first:100) { nodes { login } } milestone { dueOn } }
        ... on DraftIssue { id title body createdAt updatedAt assignees(first:100) { nodes { login } } }
      }
    } pageInfo { hasNextPage endCursor } }
  } }
}`;

function date(value: string | null | undefined) {
  const day = value?.slice(0, 10);
  return day && z.iso.date().safeParse(day).success ? day : undefined;
}

function nextCursor(info: z.infer<typeof pageInfoSchema>) {
  if (!info.hasNextPage) return;
  if (!info.endCursor)
    throw new TaskReadError(
      "GitHub returned incomplete pagination. Refresh this source to try again.",
    );
  return info.endCursor;
}

function description(value: string | null | undefined) {
  const body = value ?? "";
  return { body: body.slice(0, 16_000), truncated: body.length > 16_000 };
}

function repoContainer(name: string): TaskSnapshot["projects"][number] {
  return {
    id: `repo:${name}`,
    name,
    order: 0,
    source: {
      kind: "repository",
      nativeId: name,
      url: `https://github.com/${name}`,
    },
  };
}

function mergeTask(previous: ProviderTask | undefined, task: ProviderTask) {
  if (!previous) return task;
  const memberships = new Map(
    previous.source?.memberships?.map((member) => [member.containerId, member]),
  );
  for (const member of task.source?.memberships ?? [])
    memberships.set(member.containerId, member);
  return {
    ...task,
    source: {
      ...task.source!,
      assignedToMe:
        previous.source?.assignedToMe || task.source?.assignedToMe || false,
      memberships: [...memberships.values()],
    },
  };
}

/** Read-only adapter: every GraphQL document is a query; no issue or Project writes. */
export class GitHubProvider {
  constructor(
    private readonly request: SourceRequest,
    private readonly account: TaskSnapshot["account"],
    private readonly login: string,
    private readonly selection: () => GitHubSelection,
    private readonly allowPrivate: () => boolean = () => false,
  ) {}

  private async graphql(query: string, variables: Record<string, unknown>) {
    const value = z
      .object({
        data: z.record(z.string(), z.unknown()).nullable().optional(),
        errors: z.array(z.object({ type: z.string().optional() })).optional(),
      })
      .parse(
        await this.request("/graphql", {
          method: "POST",
          body: { query, variables },
        }),
      );
    if (value.errors?.some((error) => error.type === "RATE_LIMITED"))
      throw new TaskReadError(
        "GitHub requests are limited. Refresh after the cooldown.",
        undefined,
        false,
        429,
      );
    return value;
  }

  async discoverProjects() {
    const budget = new SourcePageBudget();
    return readSourcePages("projects", budget, async (limit, cursor) => {
      const result = await this.graphql(
        `query DayPlannerProjects($first:Int!, $after:String) { viewer { projectsV2(first:$first, after:$after) { nodes { id title url } pageInfo { hasNextPage endCursor } } } }`,
        { first: limit, after: cursor ?? null },
      );
      if (result.errors?.length || !result.data)
        throw new TaskReadError(
          "GitHub could not list your Projects. Check the Projects permission.",
          undefined,
          false,
          403,
        );
      const data = z
        .object({
          viewer: z.object({
            projectsV2: z.object({
              nodes: z.array(projectSummarySchema.nullable()),
              pageInfo: pageInfoSchema,
            }),
          }),
        })
        .parse(result.data);
      const page = data.viewer.projectsV2;
      return {
        items: page.nodes.filter((item) => item !== null),
        next: nextCursor(page.pageInfo),
      };
    });
  }

  async lookupProject(url: string) {
    const location = githubProjectLocation(url);
    if (!location)
      throw new TaskReadError(
        "Enter a github.com user or organization Project URL.",
      );
    const owner = location.kind;
    const result = await this.graphql(
      `query DayPlannerProjectLocation($login:String!, $number:Int!) { ${owner}(login:$login) { projectV2(number:$number) { id title url } } }`,
      { login: location.owner, number: location.number },
    );
    if (!result.data || result.errors?.length)
      throw new TaskReadError(
        "This GitHub Project is unavailable. Check its URL and permissions.",
        undefined,
        false,
        403,
      );
    const data = z
      .object({ projectV2: projectSummarySchema.nullable() })
      .nullable()
      .parse(result.data[owner]);
    if (!data?.projectV2)
      throw new TaskReadError(
        "This GitHub Project is unavailable. Check its URL and permissions.",
        undefined,
        false,
        404,
      );
    return data.projectV2;
  }

  async read(previous?: SourceReadResult): Promise<SourceReadResult> {
    if (
      previous &&
      (previous.snapshot.provider !== "github" ||
        previous.snapshot.account.id !== this.account.id)
    )
      throw new TaskReadError("Refresh the current GitHub account first.");
    const selected = this.selection();
    const includePrivate = this.allowPrivate();
    const budget = new SourcePageBudget();
    const oldStates = new Map(
      previous?.coverage.streams.map((state) => [state.id, state]),
    );
    const projects = new Map(
      previous?.snapshot.projects.map((project) => [project.id, project]),
    );
    const tasks = new Map(
      previous?.snapshot.tasks
        .filter((task) => includePrivate || !task.source?.private)
        .map((task) => [task.id, task]),
    );
    const streams: SourcePageState[] = [];
    let unavailableItems = previous?.coverage.unavailableItems ?? 0;
    const issueStreams = [
      ...(selected.assigned
        ? [
            {
              id: "github-assigned",
              path: "/issues?filter=assigned",
              repository: undefined,
            },
          ]
        : []),
      ...selected.repositories.map((value) => {
        const name = githubRepository(value);
        if (!name)
          throw new TaskReadError(
            "A selected GitHub repository is invalid. Choose owner/repository.",
          );
        projects.set(`repo:${name}`, repoContainer(name));
        return {
          id: `repo:${name}`,
          path: `/repos/${name.split("/").map(encodeURIComponent).join("/")}/issues?filter=all`,
          repository: name,
        };
      }),
    ];
    for (const stream of issueStreams) {
      let repositoryPrivate: boolean | undefined;
      try {
        const page = await readSourcePages(
          stream.id,
          budget,
          async (_limit, cursor) => {
            if (stream.repository && repositoryPrivate === undefined) {
              const repo = z
                .object({ private: z.boolean() })
                .parse(
                  await this.request(
                    `/repos/${stream.repository.split("/").map(encodeURIComponent).join("/")}`,
                  ),
                );
              repositoryPrivate = repo.private;
              if (repo.private && !includePrivate)
                throw new TaskReadError(
                  "Private repository access is off. Enable it in Connections to include this repository.",
                  undefined,
                  false,
                  403,
                );
            }
            const pageNumber = cursor ? Number(cursor) : 1;
            if (!Number.isSafeInteger(pageNumber) || pageNumber < 1)
              throw new TaskReadError(
                "Refresh this GitHub source to restart pagination.",
              );
            const rows = z
              .array(issueSchema)
              .parse(
                await this.request(
                  `${stream.path}&state=open&sort=created&direction=asc&per_page=100&page=${pageNumber}`,
                ),
              );
            return {
              items: rows,
              next: rows.length === 100 ? String(pageNumber + 1) : undefined,
            };
          },
          oldStates.get(stream.id),
          100,
        );
        let order =
          Math.max(
            -1,
            ...[...tasks.values()].flatMap(
              (task) =>
                task.source?.memberships
                  ?.filter((member) => member.containerId === stream.id)
                  .map((member) => member.order) ?? [],
            ),
          ) + 1;
        for (const issue of page.items) {
          if (issue.pull_request !== undefined) continue;
          const isPrivate = issue.repository?.private ?? repositoryPrivate;
          if (!includePrivate && isPrivate !== false) {
            unavailableItems++;
            continue;
          }
          const path = new URL(issue.html_url).pathname.split("/");
          const name =
            stream.repository ?? githubRepository(`${path[1]}/${path[2]}`);
          if (!name) continue;
          projects.set(`repo:${name}`, repoContainer(name));
          const body = description(issue.body);
          const assignees = issue.assignees.map((user) => user.login);
          const milestoneDate = date(issue.milestone?.due_on);
          const task: ProviderTask = {
            id: issue.node_id,
            title: issue.title,
            description: body.body,
            projectId: `repo:${name}`,
            parentId: null,
            labels: issue.labels.map((label) =>
              typeof label === "string" ? label : label.name,
            ),
            priority: 1,
            completed: issue.state === "closed",
            order,
            createdAt: issue.created_at,
            due: null,
            source: {
              kind: "issue",
              nativeId: issue.node_id,
              nativeContainerId: name,
              url: issue.html_url,
              updatedAt: issue.updated_at,
              state: issue.state,
              number: issue.number,
              assignees,
              assignedToMe:
                stream.id === "github-assigned" ||
                assignees.some(
                  (login) => login.toLowerCase() === this.login.toLowerCase(),
                ),
              private: isPrivate ?? true,
              descriptionTruncated: body.truncated,
              ...(milestoneDate ? { milestoneDate } : {}),
              memberships: [
                { containerId: stream.id, itemId: issue.node_id, order },
              ],
            },
          };
          tasks.set(task.id, mergeTask(tasks.get(task.id), task));
          order++;
        }
        streams.push({ ...page.state, containerId: stream.id });
      } catch (error) {
        if (
          !(error instanceof TaskReadError) ||
          error.needsReconnect ||
          error.retryAt ||
          error.status === 429
        )
          throw error;
        streams.push({
          id: stream.id,
          containerId: stream.id,
          complete: false,
          error: error.message,
        });
      }
    }
    for (const selectedProject of selected.projects) {
      const id = selectedProject.id;
      if (!projects.has(id))
        projects.set(id, {
          id,
          name: selectedProject.title,
          order: projects.size,
          source: { kind: "project", nativeId: id, url: selectedProject.url },
        });
      let partial = false;
      try {
        const page = await readSourcePages(
          id,
          budget,
          async (limit, cursor) => {
            const result = await this.graphql(projectQuery, {
              id,
              first: limit,
              after: cursor ?? null,
            });
            if (!result.data?.node)
              throw new TaskReadError(
                "This GitHub Project is unavailable. Check permissions or organization approval.",
                undefined,
                false,
                403,
              );
            partial ||= Boolean(result.errors?.length);
            const project = projectSchema.parse(result.data.node);
            const fields = project.fields.nodes.flatMap((field) =>
              field &&
              (field.dataType === "SINGLE_SELECT" || field.dataType === "DATE")
                ? [
                    {
                      id: field.id,
                      name: field.name,
                      type:
                        field.dataType === "DATE"
                          ? ("date" as const)
                          : ("single-select" as const),
                      ...(field.options ? { options: field.options } : {}),
                    },
                  ]
                : [],
            );
            projects.set(id, {
              id,
              name: project.title,
              order: projects.get(id)?.order ?? projects.size,
              source: {
                kind: "project",
                nativeId: id,
                url: project.url,
                fields,
                fieldsComplete: !project.fields.pageInfo.hasNextPage,
              },
            });
            if (
              selectedProject.statusFieldId &&
              !fields.some(
                (field) =>
                  field.id === selectedProject.statusFieldId &&
                  field.type === "single-select",
              )
            )
              partial = true;
            if (
              selectedProject.dateFieldId &&
              !fields.some(
                (field) =>
                  field.id === selectedProject.dateFieldId &&
                  field.type === "date",
              )
            )
              partial = true;
            return {
              items: project.items.nodes,
              next: nextCursor(project.items.pageInfo),
            };
          },
          oldStates.get(id),
        );
        let order =
          Math.max(
            -1,
            ...[...tasks.values()].flatMap(
              (task) =>
                task.source?.memberships
                  ?.filter((member) => member.containerId === id)
                  .map((member) => member.order) ?? [],
            ),
          ) + 1;
        for (const item of page.items) {
          if (!item?.content) {
            unavailableItems++;
            continue;
          }
          if (item.isArchived) continue;
          if (item.fieldValues.pageInfo.hasNextPage) partial = true;
          const content = item.content;
          if (content.repository?.isPrivate && !includePrivate) {
            unavailableItems++;
            continue;
          }
          const draft = content.__typename === "DraftIssue";
          const name = content.repository
            ? githubRepository(content.repository.nameWithOwner)
            : undefined;
          if (name) projects.set(`repo:${name}`, repoContainer(name));
          const body = description(content.body);
          const assignees =
            content.assignees?.nodes.flatMap((user) =>
              user ? [user.login] : [],
            ) ?? [];
          const values = item.fieldValues.nodes;
          const status = values.find(
            (value) =>
              value?.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
              value.field?.id === selectedProject.statusFieldId,
          );
          const target = values.find(
            (value) =>
              value?.__typename === "ProjectV2ItemFieldDateValue" &&
              value.field?.id === selectedProject.dateFieldId,
          );
          const targetDate = date(target?.date);
          const membership: TaskMembership = {
            containerId: id,
            itemId: item.id,
            order,
            ...(status?.optionId && status.name && selectedProject.statusFieldId
              ? {
                  status: {
                    fieldId: selectedProject.statusFieldId,
                    optionId: status.optionId,
                    name: status.name,
                  },
                }
              : {}),
            ...(targetDate && selectedProject.dateFieldId
              ? {
                  date: {
                    fieldId: selectedProject.dateFieldId,
                    value: targetDate,
                  },
                }
              : {}),
          };
          const milestoneDate = date(content.milestone?.dueOn);
          const state = content.state === "OPEN" || draft ? "open" : "closed";
          const task: ProviderTask = {
            id: draft ? item.id : content.id,
            title: content.title,
            description: body.body,
            projectId: name ? `repo:${name}` : id,
            parentId: null,
            labels:
              content.labels?.nodes.flatMap((label) =>
                label ? [label.name] : [],
              ) ?? [],
            priority: 1,
            completed: state === "closed",
            order,
            createdAt: content.createdAt,
            due: null,
            source: {
              kind: draft
                ? "draft"
                : content.__typename === "PullRequest"
                  ? "pull-request"
                  : "issue",
              nativeId: content.id,
              nativeContainerId: name ?? id,
              url: content.url ?? selectedProject.url,
              updatedAt: content.updatedAt,
              state,
              ...(content.number ? { number: content.number } : {}),
              assignees,
              assignedToMe: assignees.some(
                (login) => login.toLowerCase() === this.login.toLowerCase(),
              ),
              private: content.repository?.isPrivate ?? false,
              memberships: [membership],
              descriptionTruncated: body.truncated,
              ...(milestoneDate ? { milestoneDate } : {}),
            },
          };
          // Conversion replaces the cached draft; the Project item remains a resolvable alias.
          if (!draft) tasks.delete(item.id);
          tasks.set(task.id, mergeTask(tasks.get(task.id), task));
          order++;
        }
        streams.push({
          ...page.state,
          containerId: id,
          ...(partial
            ? {
                complete: false,
                error:
                  "Some Project fields or items are unavailable. Check permissions and reselect missing field mappings.",
              }
            : {}),
        });
      } catch (error) {
        if (
          !(error instanceof TaskReadError) ||
          error.needsReconnect ||
          error.retryAt ||
          error.status === 429
        )
          throw error;
        streams.push({
          id,
          containerId: id,
          complete: false,
          error: error.message,
        });
      }
    }
    return {
      snapshot: {
        provider: "github",
        account: {
          ...this.account,
          capabilities: { complete: false, privateAccess: includePrivate },
        },
        projects: [...projects.values()],
        tasks: [...tasks.values()],
        fetchedAt: new Date().toISOString(),
      },
      coverage: {
        complete: streams.every((state) => state.complete),
        streams,
        unavailableItems,
      },
    };
  }
}
