/**
 * Conversation scroll surface — holds the thread of messages + markers.
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { OverlayScroll } from "@/components/OverlayScroll";

export function Conversation({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="conversation"
      className={cn("chat-surface relative flex min-h-0 flex-1 flex-col", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function ConversationContent({
  className,
  children,
  viewportClassName,
}: {
  className?: string;
  children: React.ReactNode;
  viewportClassName?: string;
}) {
  return (
    <OverlayScroll
      className={cn("messages min-h-0 flex-1", className)}
      viewportClassName={cn("messages__viewport", viewportClassName)}
    >
      <div
        data-slot="conversation-content"
        className="messages__col mx-auto flex w-full max-w-[48rem] flex-col gap-4 px-1 py-2"
      >
        {children}
      </div>
    </OverlayScroll>
  );
}
