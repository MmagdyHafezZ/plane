/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { redirect } from "react-router";

export const clientLoader = ({ params }: { params: { workItem?: string } }) => {
  const { workItem } = params;
  throw redirect(`/tickets/browse/${workItem ? `${workItem}/` : ""}`);
};

export default function BrowseRedirect() {
  return null;
}
