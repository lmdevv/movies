/**
 * How a tab screen tells the tab bar it scrolled. The iPhone's system tab bar watches scrolling
 * itself, so there the report goes nowhere; the web preview's tab bar minimizes from it like the
 * system one.
 */
import { createContext, useContext } from "react";

/** Reports a tab screen's vertical scroll offset. */
type ScrollReport = (offsetY: number) => void;

const ignore: ScrollReport = () => undefined;

/** Provided by the web preview's tab layout. */
export const TabBarScrollContext = createContext<ScrollReport>(ignore);

/** The function a tab screen calls with its scroll offset. */
export const useTabBarScroll = (): ScrollReport => useContext(TabBarScrollContext);
