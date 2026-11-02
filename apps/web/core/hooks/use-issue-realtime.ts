/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { useParams } from "next/navigation";
// plane imports
import { LIVE_BASE_PATH, LIVE_BASE_URL } from "@plane/constants";
// hooks
import { useUser } from "@/hooks/store/user";

// Debounce window to coalesce bursts of issue events into a single refresh
const ISSUE_EVENT_DEBOUNCE_MS = 500;

export type TIssueRealtimeEventData = {
  project_id: string;
  issue_id: string | null;
  type: string | null;
  actor_id: string | null;
};

type TIssueRealtimePayload = {
  event: string;
  data: TIssueRealtimeEventData;
};

type TProjectSubscription = {
  provider: HocuspocusProvider;
  listeners: Set<(data: TIssueRealtimeEventData) => void>;
  destroyTimeout: ReturnType<typeof setTimeout> | null;
};

// Module-level cache so multiple components watching the same project share one WebSocket connection
const subscriptions = new Map<string, TProjectSubscription>();

const getOrCreateSubscription = (
  projectId: string,
  workspaceSlug: string | undefined,
  currentUser: { id: string; display_name?: string | null }
): TProjectSubscription | null => {
  let sub = subscriptions.get(projectId);
  if (sub) {
    if (sub.destroyTimeout) {
      clearTimeout(sub.destroyTimeout);
      sub.destroyTimeout = null;
    }
    return sub;
  }

  let wsLiveUrl: URL;
  try {
    const liveServerBaseUrl = LIVE_BASE_URL?.trim() || window.location.origin;
    wsLiveUrl = new URL(liveServerBaseUrl);
    const isSecureEnvironment = window.location.protocol === "https:";
    wsLiveUrl.protocol = isSecureEnvironment ? "wss" : "ws";
    wsLiveUrl.pathname = `${LIVE_BASE_PATH}/collaboration`;
    if (workspaceSlug) wsLiveUrl.searchParams.set("workspaceSlug", workspaceSlug);
    wsLiveUrl.searchParams.set("projectId", projectId);
    wsLiveUrl.searchParams.set("documentType", "project_page");
  } catch (error) {
    console.error("Error creating issue realtime config", error);
    return null;
  }

  const listeners = new Set<(data: TIssueRealtimeEventData) => void>();

  let provider: HocuspocusProvider;
  try {
    provider = new HocuspocusProvider({
      name: `issue-events:${projectId}`,
      token: JSON.stringify({ id: currentUser.id, name: currentUser.display_name ?? "" }),
      url: wsLiveUrl.toString(),
    });
  } catch (error) {
    console.error("Error initializing HocuspocusProvider for issue realtime", error);
    return null;
  }

  const handleStateless = ({ payload }: { payload: string }) => {
    try {
      const parsedPayload = JSON.parse(payload) as TIssueRealtimePayload;
      if (parsedPayload.event !== "issue_changed") return;
      listeners.forEach((listener) => {
        try {
          listener(parsedPayload.data);
        } catch (err) {
          console.error("Error in realtime listener callback", err);
        }
      });
    } catch (error) {
      console.error("Error handling issue realtime event", error);
    }
  };

  provider.on("stateless", handleStateless);

  sub = {
    provider,
    listeners,
    destroyTimeout: null,
  };

  subscriptions.set(projectId, sub);
  return sub;
};

/**
 * Subscribes to realtime issue change events for a project over the live server
 * and invokes `onIssueEvent` (debounced) whenever an issue is created or updated.
 *
 * Supports multi-device / multi-tab syncing by dispatching all remote change events.
 * Multiple subscribers in the same project share a single WebSocket connection.
 *
 * @param projectId - The project to subscribe to
 * @param onIssueEvent - Callback invoked (debounced) on issue changes, with event data
 */
export const useIssueRealtime = (
  projectId: string | undefined,
  onIssueEvent: (data: TIssueRealtimeEventData) => void
) => {
  const { workspaceSlug: routerWorkspaceSlug } = useParams();
  const workspaceSlug = routerWorkspaceSlug ? routerWorkspaceSlug.toString() : undefined;
  const { data: currentUser } = useUser();

  const onIssueEventRef = useRef(onIssueEvent);
  onIssueEventRef.current = onIssueEvent;

  useEffect(() => {
    if (typeof window === "undefined" || !projectId || !currentUser?.id) return;

    const sub = getOrCreateSubscription(projectId, workspaceSlug, currentUser);
    if (!sub) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const listener = (data: TIssueRealtimeEventData) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        onIssueEventRef.current(data);
      }, ISSUE_EVENT_DEBOUNCE_MS);
    };

    sub.listeners.add(listener);

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      sub.listeners.delete(listener);

      // If no more listeners for this project, schedule a cleanup.
      // Small timeout avoids thrashing connections on page transitions or Fast Refresh.
      if (sub.listeners.size === 0) {
        if (sub.destroyTimeout) clearTimeout(sub.destroyTimeout);
        sub.destroyTimeout = setTimeout(() => {
          try {
            sub.provider.destroy();
          } catch (err) {
            console.error("Error destroying issue realtime provider:", err);
          }
          subscriptions.delete(projectId);
        }, 1500);
      }
    };
  }, [projectId, workspaceSlug, currentUser]);
};
