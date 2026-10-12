import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { ScrollView, useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { PrButton, PrNotice, PrStateMessage } from "./pull-request-components";
import { useEnvironmentQuery } from "../../state/query";
import { pullRequestEnvironment } from "../../state/pull-requests";
import { buildReviewParsedDiff } from "../review/reviewModel";
import {
  buildNativeReviewDiffData,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
} from "../review/nativeReviewDiffAdapter";
import { resolveNativeReviewDiffView } from "../diffs/nativeReviewDiffSurface";
import { useNativeReviewDiffBridge } from "../review/useNativeReviewDiffBridge";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";

const NativeDiff = resolveNativeReviewDiffView();

const EMPTY_IDS: ReadonlyArray<string> = Object.freeze([]);

export function PullRequestCode(props: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
}) {
  const [collapsedFileIds, setCollapsedFileIds] = useState<ReadonlyArray<string>>(EMPTY_IDS);
  const [viewedFileIds, setViewedFileIds] = useState<ReadonlyArray<string>>(EMPTY_IDS);
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useEnvironmentQuery(
    pullRequestEnvironment.diff({
      environmentId: props.environmentId,
      input: { ...props.reference, ...(cursor ? { cursor } : {}) },
    }),
  );
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const { nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const parsed = useMemo(
    () => buildReviewParsedDiff(query.data?.patch, JSON.stringify(props.reference)),
    [query.data?.patch, props.reference],
  );
  const data = useMemo(() => buildNativeReviewDiffData(parsed), [parsed]);
  const bridge = useNativeReviewDiffBridge({
    threadKey: JSON.stringify([props.environmentId, props.reference]),
    sectionId: cursor ?? "first",
    diff: query.data?.patch,
    data,
    collapsedFileIds,
    viewedFileIds,
    selectedRowIds: EMPTY_IDS,
    canHighlight: parsed.kind === "files",
  });
  const insets = useSafeAreaInsets();
  if (query.data === null)
    return query.error ? (
      <PrStateMessage
        icon="chevron.left.forwardslash.chevron.right"
        title="Could not load the changes"
        message={query.error}
      >
        <PrButton label="Retry" icon="arrow.clockwise" onPress={query.refresh} />
      </PrStateMessage>
    ) : (
      <PrStateMessage
        icon="chevron.left.forwardslash.chevron.right"
        title="Loading changed files"
        loading
      />
    );
  const filesLabel = `${data.files.length} ${data.files.length === 1 ? "file" : "files"}`;
  const paged = cursor !== undefined || Boolean(query.data.nextCursor);
  return (
    <View className="flex-1" style={{ paddingBottom: paged ? 0 : insets.bottom }}>
      <View className="pt-2">
        {query.error ? (
          <PrNotice lines={[query.error]} actionLabel="Retry" onAction={query.refresh} />
        ) : null}
        {query.data.truncated ? (
          <PrNotice
            lines={[
              "Some binary files or omitted hunks cannot be shown here. Open the pull request on its host to see them.",
            ]}
          />
        ) : null}
      </View>
      {parsed.kind === "files" && NativeDiff ? (
        <NativeDiff
          style={{ flex: 1 }}
          rowsJson={bridge.rowsJson}
          tokensPatchJson={bridge.tokensPatchJson}
          tokensResetKey={bridge.tokensResetKey}
          contentResetKey={bridge.tokensResetKey}
          collapsedFileIdsJson={bridge.collapsedFileIdsJson}
          viewedFileIdsJson={bridge.viewedFileIdsJson}
          onDebug={bridge.onDebug}
          onToggleFile={(event) => {
            const id = event.nativeEvent.fileId;
            if (id)
              setCollapsedFileIds((current) =>
                current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
              );
          }}
          onToggleViewedFile={(event) => {
            const id = event.nativeEvent.fileId;
            if (id)
              setViewedFileIds((current) =>
                current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
              );
          }}
          appearanceScheme={scheme}
          themeJson={bridge.themeJson}
          styleJson={bridge.styleJson}
          rowHeight={nativeReviewDiffStyle.rowHeight}
          contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
        />
      ) : (
        <ScrollView className="flex-1" horizontal>
          <ScrollView>
            <Text selectable className="p-4 font-mono text-foreground">
              {query.data.patch || "No text changes in this slice."}
            </Text>
          </ScrollView>
        </ScrollView>
      )}
      {paged ? (
        <View
          className="flex-row items-center gap-2 border-t border-border bg-screen px-3 pt-2"
          style={{ paddingBottom: Math.max(insets.bottom, 8) }}
        >
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
            {filesLabel} in this slice
          </Text>
          {cursor ? <PrButton label="First files" onPress={() => setCursor(undefined)} /> : null}
          {query.data.nextCursor ? (
            <PrButton
              label="Next files"
              busy={query.isPending}
              onPress={() => setCursor(query.data!.nextCursor!)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
