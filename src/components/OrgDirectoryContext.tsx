"use client";

import { createContext, useContext } from "react";

export type OrgLite = { id: number; name?: string | null; status?: string | null };

/**
 * The Super Admin's organization directory, published once by GoMinaApp so
 * shared scope controls (UnitScopeOptions, BusinessScopeBar) can name the owner
 * of each unit without every panel having to thread a prop. Normal users load
 * no directory — their unit lists are single-owner anyway.
 */
const OrgDirectoryContext = createContext<OrgLite[]>([]);

export const OrgDirectoryProvider = OrgDirectoryContext.Provider;

export function useOrgDirectory(): OrgLite[] {
  return useContext(OrgDirectoryContext);
}
