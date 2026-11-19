import type { TaskSnapshot } from "./types";

/** Project fields affect the selected view without changing the canonical issue. */
export function githubTaskView(
  snapshot: TaskSnapshot,
  view: {
    kind: "assigned" | "repository" | "project";
    id?: string;
    statusOptionIds?: readonly string[];
  },
): TaskSnapshot {
  return {
    ...snapshot,
    tasks: snapshot.tasks.flatMap((task) => {
      if (view.kind === "assigned")
        return task.source?.assignedToMe
          ? [
              {
                ...task,
                order:
                  task.source.memberships?.find(
                    (member) => member.containerId === "github-assigned",
                  )?.order ?? task.order,
              },
            ]
          : [];
      if (view.kind === "repository")
        return task.source?.nativeContainerId?.toLowerCase() ===
          view.id?.toLowerCase()
          ? [
              {
                ...task,
                order:
                  task.source?.memberships?.find(
                    (member) =>
                      member.containerId === `repo:${view.id?.toLowerCase()}`,
                  )?.order ?? task.order,
              },
            ]
          : [];
      const member = task.source?.memberships?.find(
        (item) => item.containerId === view.id,
      );
      if (
        !member ||
        (view.statusOptionIds?.length &&
          (!member.status ||
            !view.statusOptionIds.includes(member.status.optionId)))
      )
        return [];
      return [
        {
          ...task,
          projectId: member.containerId,
          order: member.order,
          due: member.date
            ? {
                date: member.date.value,
                recurring: false,
                text: member.date.value,
                timezone: null,
              }
            : null,
          source: { ...task.source!, dateMeaning: "target" },
        },
      ];
    }),
  };
}
