import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  countActivePullRequestFilters,
  DEFAULT_PULL_REQUEST_FILTERS,
  PULL_REQUEST_INVOLVEMENT_OPTIONS,
  PULL_REQUEST_SORT_OPTIONS,
  PULL_REQUEST_STATE_OPTIONS,
  type PullRequestFilters,
} from "./pull-request-model";
import { PrButton, PrChoice } from "./pull-request-components";

function Section(props: { title: string; children: ReactNode }) {
  return (
    <View className="gap-2.5">
      <Text className="text-xs font-t3-bold text-foreground-muted">{props.title}</Text>
      {props.children}
    </View>
  );
}

/**
 * Environment, sort, state, involvement and project in one sheet, matching the desktop Filters menu. Choices apply
 * as they are tapped, so the list behind the sheet is already the answer when it closes.
 */
export function PullRequestFiltersSheet(props: {
  visible: boolean;
  filters: PullRequestFilters;
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  /** Projects whose repository could not be read, with the reason, so they are not offered. */
  unavailable: ReadonlyMap<string, string>;
  onChange: (patch: Partial<PullRequestFilters>) => void;
  environments: ReadonlyArray<{
    readonly environmentId: string;
    readonly environmentLabel: string;
  }>;
  environmentId: string;
  onEnvironmentChange: (environmentId: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const iconColor = String(useUniwindTheme()["--color-icon"]);
  const active =
    countActivePullRequestFilters(props.filters) > 0 ||
    props.filters.sort !== DEFAULT_PULL_REQUEST_FILTERS.sort;
  // Readable projects lead, so a run of unavailable ones does not read as an empty menu.
  const projects = [...props.projects].sort(
    (a, b) => Number(props.unavailable.has(a.id)) - Number(props.unavailable.has(b.id)),
  );
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={props.onClose}
    >
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityLabel="Close filters"
          className="absolute inset-0 bg-backdrop"
          onPress={props.onClose}
        />
        <View
          className="max-h-[85%] w-full max-w-[560px] self-center rounded-t-2xl border border-b-0 border-border bg-card"
          style={{ paddingBottom: Math.max(insets.bottom, 12) }}
        >
          <View className="flex-row items-center border-b border-border pl-4 pr-1">
            <Text className="flex-1 text-base font-t3-bold text-foreground">Filters</Text>
            {active ? (
              <Pressable
                accessibilityRole="button"
                className="min-h-11 justify-center px-3"
                onPress={() =>
                  props.onChange({
                    state: DEFAULT_PULL_REQUEST_FILTERS.state,
                    involvement: DEFAULT_PULL_REQUEST_FILTERS.involvement,
                    projectId: undefined,
                    sort: DEFAULT_PULL_REQUEST_FILTERS.sort,
                  })
                }
              >
                <Text className="text-sm font-t3-medium text-foreground-secondary">Reset</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityLabel="Close filters"
              accessibilityRole="button"
              className="size-11 items-center justify-center"
              onPress={props.onClose}
            >
              <SymbolView name="xmark" size={16} tintColor={iconColor} type="monochrome" />
            </Pressable>
          </View>
          <ScrollView
            contentContainerClassName="gap-5 px-4 py-4"
            showsVerticalScrollIndicator={false}
          >
            {props.environments.length > 1 ? (
              <Section title="Environment">
                <View className="flex-row flex-wrap gap-2" accessibilityRole="radiogroup">
                  {props.environments.map((environment) => (
                    <PrChoice
                      key={environment.environmentId}
                      label={environment.environmentLabel}
                      selected={environment.environmentId === props.environmentId}
                      onPress={() => {
                        if (environment.environmentId !== props.environmentId) {
                          props.onEnvironmentChange(environment.environmentId);
                        }
                      }}
                    />
                  ))}
                </View>
              </Section>
            ) : null}
            <Section title="Sort">
              <View className="flex-row flex-wrap gap-2" accessibilityRole="radiogroup">
                {PULL_REQUEST_SORT_OPTIONS.map((option) => (
                  <PrChoice
                    key={option.value}
                    label={option.label}
                    selected={props.filters.sort === option.value}
                    onPress={() => props.onChange({ sort: option.value })}
                  />
                ))}
              </View>
            </Section>
            <Section title="State">
              <View className="flex-row flex-wrap gap-2" accessibilityRole="radiogroup">
                {PULL_REQUEST_STATE_OPTIONS.map((option) => (
                  <PrChoice
                    key={option.value}
                    label={option.label}
                    selected={props.filters.state === option.value}
                    onPress={() => props.onChange({ state: option.value })}
                  />
                ))}
              </View>
            </Section>
            <Section title="Involvement">
              <View className="flex-row flex-wrap gap-2" accessibilityRole="radiogroup">
                {PULL_REQUEST_INVOLVEMENT_OPTIONS.map((option) => (
                  <PrChoice
                    key={option.value}
                    label={option.label}
                    selected={props.filters.involvement === option.value}
                    onPress={() => props.onChange({ involvement: option.value })}
                  />
                ))}
              </View>
            </Section>
            <Section title="Project">
              <View
                accessibilityRole="radiogroup"
                className="overflow-hidden rounded-lg border border-border"
              >
                <ProjectRow
                  first
                  title="All projects"
                  selected={props.filters.projectId === undefined}
                  onPress={() => props.onChange({ projectId: undefined })}
                />
                {projects.map((project) => (
                  <ProjectRow
                    key={project.id}
                    title={project.title}
                    selected={props.filters.projectId === project.id}
                    unavailable={props.unavailable.get(project.id)}
                    onPress={() => props.onChange({ projectId: project.id })}
                  />
                ))}
              </View>
            </Section>
          </ScrollView>
          <View className="px-4 pt-1">
            <PrButton variant="primary" label="Done" onPress={props.onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ProjectRow(props: {
  title: string;
  first?: boolean;
  selected: boolean;
  unavailable?: string | undefined;
  onPress: () => void;
}) {
  const iconColor = String(useUniwindTheme()["--color-icon"]);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: props.selected, disabled: props.unavailable !== undefined }}
      disabled={props.unavailable !== undefined}
      onPress={props.onPress}
      className={cn(
        "min-h-12 flex-row items-center gap-3 border-border px-3.5 py-2 active:bg-subtle",
        !props.first && "border-t",
        props.unavailable !== undefined && "opacity-55",
      )}
    >
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-sm text-foreground">
          {props.title}
        </Text>
        {props.unavailable !== undefined ? (
          <Text numberOfLines={2} className="text-xs text-foreground-muted">
            Unavailable: {props.unavailable}
          </Text>
        ) : null}
      </View>
      {props.selected ? (
        <SymbolView name="checkmark" size={16} tintColor={iconColor} type="monochrome" />
      ) : null}
    </Pressable>
  );
}
