import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
  type TextInputInstance,
  View,
} from "react-native";

import { AndroidHeaderIconButton } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { MaterialSearchField } from "../../components/MaterialSearchField";
import { useMaterialToolbarLayout } from "../../components/useMaterialToolbarLayout";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";

/**
 * The pull request list's top bar, built like Home's: search, filters and refresh as header
 * icons, and search replacing the bar until it is closed. Closing search clears the query.
 */
export function PullRequestListToolbar(props: {
  readonly onBack: () => void;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly filterCount: number;
  readonly filterCustomized: boolean;
  readonly onOpenFilters: () => void;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}) {
  const { height: toolbarHeight, ...headerPadding } = useMaterialToolbarLayout();
  const titleTypography = useScaledTextRole("title");
  const { onSearchQueryChange } = props;
  const searchRef = useRef<TextInputInstance>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = searchOpen || props.searchQuery.length > 0;

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    searchRef.current?.focus();
    return true;
  }, []);
  useHardwareKeyboardCommand("focusSearch", openSearch);

  const closeSearch = useCallback(() => {
    onSearchQueryChange("");
    setSearchOpen(false);
    Keyboard.dismiss();
  }, [onSearchQueryChange]);

  useEffect(() => {
    if (!searching) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [closeSearch, searching]);

  return (
    <View className="bg-header px-2" style={headerPadding}>
      <View className="flex-row items-center gap-1" style={{ minHeight: toolbarHeight }}>
        {searching ? (
          <>
            <AndroidHeaderIconButton
              accessibilityLabel="Close search"
              icon="arrow.left"
              onPress={closeSearch}
            />
            <MaterialSearchField
              inputRef={searchRef}
              accessibilityLabel="Search pull requests"
              clearAccessibilityLabel="Clear search"
              placeholder="Search title, #number or author"
              value={props.searchQuery}
              onChangeText={onSearchQueryChange}
            />
          </>
        ) : (
          <>
            <AndroidHeaderIconButton
              accessibilityLabel="Navigate up"
              icon="arrow.left"
              onPress={props.onBack}
            />
            <Text
              numberOfLines={1}
              style={titleTypography}
              className="min-w-0 flex-1 text-header-foreground"
            >
              Pull requests
            </Text>
            <AndroidHeaderIconButton
              accessibilityLabel="Search pull requests"
              icon="magnifyingglass"
              onPress={openSearch}
            />
            <AndroidHeaderIconButton
              accessibilityLabel={
                props.filterCount > 0 ? `Filters, ${props.filterCount} active` : "Filters"
              }
              icon={
                props.filterCustomized
                  ? "line.3.horizontal.decrease.circle.fill"
                  : "line.3.horizontal.decrease.circle"
              }
              selected={props.filterCustomized}
              onPress={props.onOpenFilters}
            />
            {props.refreshing ? (
              <View
                accessibilityLabel="Refreshing pull requests"
                className="size-12 items-center justify-center"
              >
                <ActivityIndicator size="small" colorClassName="accent-icon" />
              </View>
            ) : (
              <AndroidHeaderIconButton
                accessibilityLabel="Refresh pull requests"
                icon="arrow.clockwise"
                onPress={props.onRefresh}
              />
            )}
          </>
        )}
      </View>
    </View>
  );
}
