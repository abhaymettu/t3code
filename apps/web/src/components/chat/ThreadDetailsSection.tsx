import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/utils";

export type ThreadDetailsSectionName =
  | "workspace"
  | "version-control"
  | "servers"
  | "automations"
  | "lineage";

/** `data-thread-details-section` is a stable anchor for plugin stylesheets. */
export function ThreadDetailsSection({
  section,
  title,
  actions,
  separated = true,
  showHeading = true,
  children,
  ...props
}: Omit<ComponentProps<"section">, "className" | "style" | "title" | "aria-labelledby"> & {
  section: ThreadDetailsSectionName;
  title: string;
  actions?: ReactNode;
  separated?: boolean;
  showHeading?: boolean;
}) {
  const headingId = `thread-details-${section}-heading`;
  return (
    <section
      {...props}
      data-thread-details-section={section}
      aria-labelledby={showHeading ? headingId : undefined}
      aria-label={showHeading ? undefined : title}
      className={cn("px-2 pt-2 pb-2.5", separated && "border-t border-border/65")}
    >
      <div
        className={cn(
          "mb-1 flex min-h-8 min-w-0 items-center justify-between gap-2 px-2.5",
          !showHeading && "hidden",
        )}
      >
        <h3
          id={headingId}
          className="min-w-0 truncate text-2xs font-medium text-muted-foreground select-none"
        >
          {title}
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
