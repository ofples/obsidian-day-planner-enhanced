import type { TaskConflictField, TaskConflictValues } from "../tasks/conflict";
import type { TaskSnapshot } from "../tasks/types";

const fieldNames: Record<string, string> = {
  title: "Title",
  description: "Description",
  placement: "Project and parent",
  schedule: "Task date and duration",
  interval: "Planned interval",
  projectId: "Project",
  completed: "Completion",
  labels: "Labels",
  priority: "Priority",
};
export function taskConflictFieldName(field: TaskConflictField) {
  if (field.fields.includes("interval")) return "Planned interval";
  if (field.key.startsWith("label:")) return `Label ${field.key.slice(6)}`;
  return fieldNames[field.key] ?? field.key;
}

export function taskConflictValue(
  values: TaskConflictValues | null,
  snapshot: TaskSnapshot | null,
) {
  if (!values) return "Unavailable";
  return Object.entries(values)
    .map(([field, value]) => {
      if (value == null) {
        if ("interval" in values && field === "due") return "No task date";
        if ("interval" in values && field === "duration")
          return "No provider duration";
        return "None";
      }
      if (field === "projectId")
        return (
          snapshot?.projects.find((project) => project.id === value)?.name ??
          String(value)
        );
      if (field === "parentId")
        return (
          snapshot?.tasks.find((task) => task.id === value)?.title ??
          String(value)
        );
      if (field === "completed") return value ? "Completed" : "Open";
      if (field === "interval")
        return `${new Date(values.interval!.start).toLocaleString()} – ${new Date(values.interval!.end).toLocaleString()}`;
      if (field === "due") {
        const date = [
          values.due!.date,
          values.due!.timezone,
          values.due!.recurring ? values.due!.text : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return "interval" in values ? `Task date ${date}` : date;
      }
      if (field === "duration")
        return `${"interval" in values ? "Provider duration " : ""}${values.duration!.amount} ${values.duration!.unit}`;
      if (Array.isArray(value)) return value.join(", ") || "None";
      return String(value) || "Empty";
    })
    .join("\n");
}
