/**
 * Chat message primitives — user bubble / assistant content / actions.
 * Composable in the spirit of shadcn Message blocks.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

export function Message({
  className,
  from,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  from?: "user" | "assistant" | "system";
}) {
  return (
    <article
      data-slot="message"
      data-from={from}
      className={cn(
        "group/message flex w-full min-w-0 flex-col gap-2",
        from === "user" && "items-end",
        from === "assistant" && "items-stretch",
        className,
      )}
      {...props}
    />
  );
}

export function MessageContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        "min-w-0 max-w-full text-[14.5px] leading-[1.6] text-[var(--text-primary)]",
        "group-data-[from=user]/message:max-w-[min(100%,42rem)]",
        "group-data-[from=user]/message:rounded-[14px]",
        "group-data-[from=user]/message:bg-[var(--bg-user-bubble)]",
        "group-data-[from=user]/message:px-3.5",
        "group-data-[from=user]/message:py-2.5",
        "group-data-[from=user]/message:whitespace-pre-wrap",
        "group-data-[from=assistant]/message:w-full",
        className,
      )}
      {...props}
    />
  );
}

export function MessageActions({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="message-actions"
      className={cn(
        "flex items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

export function MessageToolbar({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="message-toolbar"
      className={cn("mt-1 flex items-center gap-1", className)}
      {...props}
    />
  );
}
