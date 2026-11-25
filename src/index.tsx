import {
  ButtonItem,
  DialogButton,
  Field,
  Focusable,
  GamepadButton,
  ModalRoot,
  PanelSection,
  PanelSectionRow,
  ToggleField,
  showModal,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin, toaster } from "@decky/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaCog, FaFolder, FaFolderOpen, FaStethoscope, FaTrash } from "react-icons/fa";

type ShortcutStatus = "healthy" | "missing" | "storage_offline" | "invalid";
type ArtworkSummary = { capsule:boolean; wide:boolean; hero:boolean; logo:boolean; icon:boolean; count:number };
type ArtworkPreview = { found:boolean; slot?:string; fileName?:string; tooLarge?:boolean; size?:number; dataUrl?:string; error?:string };
type ArtworkPreviewBundle = { items:ArtworkPreview[]; error?:string };
type CompatibilityTool = { strToolName:string; strDisplayName:string };
type ShortcutItem = { key:string; appId?:number; artwork?:ArtworkSummary; name:string; exe:string; startDir:string; launchOptions:string; status:ShortcutStatus; storageRoot?:string; utilityShortcut?:boolean };
type DuplicateGroup = { exe:string; count:number; items:ShortcutItem[]; gameRoot?:string; gameName?:string };
type UnregisteredExecutable = { name:string; path:string; relativePath:string; rootFolder:string; gameRoot?:string; gameName?:string; candidateScore:number; candidateLabel:"high"|"medium"|"low" };
type Settings = { watchedFolders:string[]; recursiveFolderScan:boolean; ignoredExecutables:string[]; defaultCompatTool:string };
type ScanCheckpoint = { seq:number; label:string; detail?:string; atMs:number };
type ScanStatus = { active:boolean; scanId:number; currentFolder:string; rootFolder:string; visitedFolders:number; foundExes:number; phase?:string; phaseDetail?:string; elapsedMs?:number; phaseElapsedMs?:number; staleMs?:number; stopRequested?:boolean; shortcutFiles?:number; shortcutItems?:number; duplicateGroups?:number; unregisteredFound?:number; resultReady?:boolean; resultError?:string|null; checkpointSeq?:number; lastCheckpoint?:ScanCheckpoint|null; checkpointHistory?:ScanCheckpoint[]; workerThreadAlive?:boolean; futureResolved?:boolean; resultStored?:boolean };
type ScanStart = { success:boolean; scanId:number };
type ScanResultEnvelope = { ready:boolean; scanId:number; result?:ScanResult|null; error?:string|null };
type ScanResult = { scanCancelled?:boolean; total:number; healthy:number; missing:number; storageOffline:number; invalid:number; filteredUtilities:number; duplicateGroups:DuplicateGroup[]; duplicateShortcuts:number; unregisteredExecutables:UnregisteredExecutable[]; ignoredExecutables:UnregisteredExecutable[]; watchedFolders:string[]; folderScanError?:string|null; folderScanTruncated:boolean; items:ShortcutItem[] };
type FolderEntry = { name:string; path:string };
type FolderListing = { path:string; parent:string; folders:FolderEntry[]; error?:string|null };
type DeletePathInfo = { exePath?:string; deletePath:string; canDelete:boolean; reason?:string };
type DeleteFolderResult = { success:boolean; path:string; alreadyMissing?:boolean; error?:string };
type DelEntry = { appId:number; name:string; exe:string; startDir:string; deletePath:string; canDelete:boolean; reason?:string };
type UserCollectionSummary = { id:string; name:string; appIds:number[] };
type StorageGame = { root:string; name:string; sizeBytes:number; appIds:number[]; shortcutCount:number; exe:string; startDir:string; exists:boolean; canDelete:boolean; reason?:string; cached:boolean; storageRoot?:string; checkedAt:number };
type StorageSummary = { games:StorageGame[]; totalBytes:number; calculatedAt:number; cacheTtlSeconds:number };

const MAX_UNREGISTERED_VISIBLE = 120;
const POST_REMOVE_DELAYS_MS = [500,800,1200,1600,2200];
const MULTI_REMOVE_GAP_MS = 260;
const scanShortcuts = callable<[], ScanResult>("scan_shortcuts");
const startScan = callable<[], ScanStart>("start_scan");
const getScanResultJson = callable<[number], string>("get_scan_result_json");
const stopScan = callable<[], {success:boolean}>("stop_scan");
const getScanStatus = callable<[], ScanStatus>("get_scan_status");
const backupShortcuts = callable<[], {success:boolean;files:string[];error?:string}>("backup_shortcuts");
const getSettings = callable<[], Settings>("get_settings");
const saveSettings = callable<[string[],boolean,string[],string], Settings>("save_settings");
const getArtworkPreview = callable<[number], ArtworkPreviewBundle>("get_artwork_preview");
const listDirectories = callable<[string], FolderListing>("list_directories");
const prepareDeleteCandidate = callable<[string,string], DeletePathInfo>("prepare_delete_candidate");
const adjustDeletePath = callable<[string,string,string], DeletePathInfo>("adjust_delete_path");
const deleteGameDirectory = callable<[string,string], DeleteFolderResult>("delete_game_directory");
const getLibraryStorage = callable<[boolean], StorageSummary>("get_library_storage");

declare const collectionStore:any;

const textStyle:React.CSSProperties={fontSize:"12.5px",lineHeight:"1.2",fontWeight:650,width:"100%",display:"block"};
const sectionText:React.CSSProperties={fontSize:"13.5px",lineHeight:"1.2",fontWeight:700,width:"100%",textAlign:"left"};
const actionColors={neutral:"#dcdedf",primary:"#67aefc",success:"#6fd08c",danger:"#ff7070",warning:"#e8bd67"};
const actionBackgrounds={neutral:"rgba(255,255,255,.07)",primary:"rgba(103,174,252,.16)",success:"rgba(111,208,140,.15)",danger:"rgba(255,112,112,.14)",warning:"rgba(232,189,103,.14)"};
const actionBorders={neutral:"rgba(255,255,255,.12)",primary:"rgba(103,174,252,.42)",success:"rgba(111,208,140,.40)",danger:"rgba(255,112,112,.40)",warning:"rgba(232,189,103,.40)"};

function formatBytes(value:number):string {
  if(!Number.isFinite(value)||value<=0)return "0 B";
  const units=["B","KB","MB","GB","TB"];
  let n=value,i=0;
  while(n>=1024&&i<units.length-1){n/=1024;i++;}
  return `${n>=100||i===0?n.toFixed(0):n>=10?n.toFixed(1):n.toFixed(2)} ${units[i]}`;
}
function storageLabel(key:"title"|"load"|"recalc"|"empty"|"total"|"games"|"more"|"delete"|"cached"|"deleteTitle"|"deleteWarn"|"freed"|"failed"|"internal"|"removable"|"selected"|"clear"|"deleteSelected"|"orphan"|"orphanDesc"|"deleteOrphan"|"addFolderToSteam"|"exeCandidates"):string {
  const table={
    en:{title:"Storage",load:"Check sizes",recalc:"Recalculate",empty:"No non-Steam game folders found.",total:"Total",games:"games",more:"Show more",delete:"Delete",cached:"cached",deleteTitle:"Delete game files?",deleteWarn:"The game folder and its non-Steam shortcut(s) will be permanently removed.",freed:"Freed",failed:"Delete failed",internal:"Internal SSD",removable:"SD / removable",selected:"Selected",clear:"Clear",deleteSelected:"Free selected space",orphan:"Orphan folders",orphanDesc:"Game folders found by the manual scan but not registered as non-Steam shortcuts.",deleteOrphan:"Delete folder",addFolderToSteam:"Add this folder to Steam",exeCandidates:"EXE candidates"},
    ko:{title:"저장공간",load:"용량 확인",recalc:"다시 계산",empty:"확인된 논스팀 게임 폴더가 없습니다.",total:"합계",games:"게임",more:"더 보기",delete:"삭제",cached:"캐시",deleteTitle:"게임 파일을 삭제할까요?",deleteWarn:"게임 폴더와 연결된 논스팀 바로가기를 함께 영구 삭제합니다.",freed:"확보",failed:"삭제 실패",internal:"내장 SSD",removable:"SD / 외장",selected:"선택",clear:"선택 해제",deleteSelected:"선택 용량 확보",orphan:"고아 폴더",orphanDesc:"수동 스캔에서 게임으로 보이지만 Steam 논스팀 바로가기에 등록되지 않은 폴더입니다.",deleteOrphan:"폴더 삭제",addFolderToSteam:"이 폴더 Steam에 추가",exeCandidates:"EXE 후보"},
    ja:{title:"ストレージ",load:"容量を確認",recalc:"再計算",empty:"非Steamゲームフォルダーが見つかりません。",total:"合計",games:"ゲーム",more:"さらに表示",delete:"削除",cached:"キャッシュ",deleteTitle:"ゲームファイルを削除しますか？",deleteWarn:"ゲームフォルダーと関連する非Steamショートカットを完全に削除します。",freed:"解放",failed:"削除失敗",internal:"内蔵 SSD",removable:"SD / 外部",selected:"選択",clear:"選択解除",deleteSelected:"選択分を解放",orphan:"孤立フォルダー",orphanDesc:"手動スキャンでゲーム候補として見つかったが、非Steamショートカットに登録されていないフォルダーです。",deleteOrphan:"フォルダー削除",addFolderToSteam:"このフォルダーを Steam に追加",exeCandidates:"EXE 候補"}
  } as const;
  return table[UI_LANGUAGE][key];
}


type UiLanguage = "ko" | "en" | "ja";
const messages = {
  en: {
    pluginName:"Library Doctor", artworkUnknown:"Artwork: unknown", artwork:"Artwork", capsule:"Capsule", wide:"Wide", hero:"Hero", logo:"Logo", icon:"Icon",
    folderBrowseFailed:"Folder browse failed: {error}", chooseScanFolder:"Choose scan folder", home:"Home", storage:"Storage", up:"Up", loading:"Loading…", noChildFolders:"No child folders.", useThisFolder:"Use this folder", cancel:"Cancel",
    removeShortcutsTitle:"Remove {count} shortcut(s)?", removeShortcutsDesc:"The {count} selected shortcut(s) will be removed from your Steam library.", gameFilesNotDeleted:"Game files are NOT deleted. This action only removes Steam shortcuts.", removeShortcuts:"Remove shortcuts",
    notScannedYet:"Not scanned yet", settingsSaveFailed:"Settings save failed: {error}", scanFailed:"Scan failed: {error}", settingsLoadFailed:"Settings load failed: {error}", backupFailed:"Backup failed. Nothing was removed. {error}", removedRefreshing:"Removed {count} shortcut(s). Refreshing…", removeFailed:"Remove failed: {error}", steamRejected:"Steam rejected {name}",
    addedWithFailures:"Added {ok}; {failed} failed.", addedSuccess:"Added {ok} shortcut(s).",
    likelyGame:"Likely game", possibleGame:"Possible game", lowConfidence:"Low confidence",
    scanning:"Scanning…", stopScan:"Stop scan", stoppingScan:"Stopping…", scanStopped:"Scan stopped", scanCurrent:"Current: {path}", scanProgress:"Folders {folders} · EXE {exes}", scanRoot:"Root: {path}", scanFinalizing:"Finalizing results…", scanPhase:"Phase: {phase}", scanElapsed:"Elapsed {elapsed}s · phase {phaseElapsed}s · no update {stale}s", scanDebug:"Debug: {detail}", scanStopRequested:"Stop requested", libraryStatus:"Library status", lastScan:"Last scan: {time}", ready:"Ready", waiting:"Waiting", scanNow:"Scan now",
    missing:"Missing", duplicates:"Duplicates", unregistered:"Unregistered", notAGame:"Not a game", libraryIssues:"Library issues", missingExecutable:"Missing executable", removeSelected:"Remove selected ({count})", storageOffline:"Storage offline", invalidShortcuts:"Invalid shortcuts",
    duplicateGroups:"Duplicate groups", group:"Group {index} · {count}", removeSelectedDuplicates:"Remove selected duplicates ({count})", exeDiscovery:"EXE discovery", scanFolders:"Scan folders", removeFolder:"Remove {folder}", addScanFolder:"Add scan folder", removeAllScanFolders:"Remove all scan folders",
    includeSubfolders:"Include subfolders", includeSubfoldersDesc:"Only likely game .exe files are shown; setup, uninstall, Python/runtime, crash-handler and similar helper executables are filtered.", folderScanWarning:"Folder scan warning", unregisteredExeFiles:"Unregistered .exe files", addSelectedToSteam:"Add selected to Steam ({count})", markSelectedNotGame:"Mark selected as not a game ({count})", resultsTruncated:"Results truncated", scanLimitReached:"The backend reached its scan limit.", removeSelectedIgnored:"Remove selected from not-a-game list ({count})",protonShortcutSettings:"Shortcut Proton settings", defaultProton:"Default Proton", steamDefault:"Steam default", chooseDefaultProton:"Choose default Proton", compatToolsUnavailable:"No compatibility tools are available.", shortcutVerified:"Added and verified {name}", shortcutUnverified:"Added {name}, but Steam read-back verification failed", settings:"Settings", scanSettings:"Scan settings", folderAdded:"Scan folder added", folderRemoved:"Scan folder removed", foldersCleared:"All scan folders removed", clearFoldersTitle:"Remove all scan folders?", clearFoldersDesc:"This removes all watched scan folders. No game files are deleted.", delQueue:"Collection cleanup", chooseDeleteCollection:"Choose collection", deleteCollection:"Collection cleanup", noCollections:"No user collections were found.", delCollectionMissing:"No deletable non-Steam shortcuts were found in the selected collection.", deleteTarget:"Delete folder", executablePath:"Executable", pathWider:"← Wider", pathNarrower:"Narrower →", deleteSelectedGames:"Delete selected game folders + shortcuts ({count})", destructiveDeleteTitle:"Permanently delete {count} game(s)?", destructiveDeleteDesc:"The selected game folders and Steam non-Steam shortcuts will be permanently removed.", destructiveDeleteWarning:"This deletes actual game files. Check every folder path before continuing.", otherShortcutWarning:"Warning: {count} other shortcut(s) point inside selected folders.", deleteGameFiles:"Delete files + shortcuts", deleteCompleted:"Deleted {ok} game(s); {failed} failed.", delCollectionReadFailed:"Could not read the selected Steam collection.", confirm:"Confirm"
  },
  ko: {
    pluginName:"라이브러리 닥터", artworkUnknown:"아트워크: 확인 불가", artwork:"아트워크", capsule:"캡슐", wide:"와이드", hero:"히어로", logo:"로고", icon:"아이콘",
    folderBrowseFailed:"폴더 탐색 실패: {error}", chooseScanFolder:"스캔 폴더 선택", home:"홈", storage:"저장소", up:"상위", loading:"불러오는 중…", noChildFolders:"하위 폴더가 없습니다.", useThisFolder:"이 폴더 선택", cancel:"취소",
    removeShortcutsTitle:"바로가기 {count}개를 삭제할까요?", removeShortcutsDesc:"선택한 Steam 바로가기 {count}개를 라이브러리에서 삭제합니다.", gameFilesNotDeleted:"실제 게임 파일은 삭제되지 않습니다. Steam 바로가기만 제거됩니다.", removeShortcuts:"바로가기 삭제",
    notScannedYet:"아직 스캔하지 않음", settingsSaveFailed:"설정 저장 실패: {error}", scanFailed:"스캔 실패: {error}", settingsLoadFailed:"설정 불러오기 실패: {error}", backupFailed:"백업에 실패하여 삭제하지 않았습니다. {error}", removedRefreshing:"바로가기 {count}개 삭제 완료. 다시 스캔합니다…", removeFailed:"삭제 실패: {error}", steamRejected:"Steam에서 {name} 등록을 거부했습니다", 
    addedWithFailures:"{ok}개 추가, {failed}개 실패.", addedSuccess:"바로가기 {ok}개를 추가했습니다.",
    likelyGame:"게임 가능성 높음", possibleGame:"게임 가능성 보통", lowConfidence:"게임 가능성 낮음",
    scanning:"스캔 중…", stopScan:"스캔 중지", stoppingScan:"중지 중…", scanStopped:"스캔을 중지했습니다", scanCurrent:"현재: {path}", scanProgress:"폴더 {folders}개 · EXE {exes}개", scanRoot:"검색 루트: {path}", scanFinalizing:"결과 정리 중…", scanPhase:"단계: {phase}", scanElapsed:"경과 {elapsed}초 · 단계 {phaseElapsed}초 · 갱신없음 {stale}초", scanDebug:"디버그: {detail}", scanStopRequested:"중지 요청됨", libraryStatus:"라이브러리 상태", lastScan:"마지막 스캔: {time}", ready:"준비됨", waiting:"대기 중", scanNow:"지금 스캔",
    missing:"실행파일 없음", duplicates:"중복", unregistered:"미등록 EXE", notAGame:"게임 아님", libraryIssues:"라이브러리 문제", missingExecutable:"실행파일 없음", removeSelected:"선택 항목 삭제 ({count})", storageOffline:"저장소 오프라인", invalidShortcuts:"잘못된 바로가기",
    duplicateGroups:"중복 그룹", group:"그룹 {index} · {count}개", removeSelectedDuplicates:"선택 중복 삭제 ({count})", exeDiscovery:"EXE 탐색", scanFolders:"스캔 폴더", removeFolder:"{folder} 제거", addScanFolder:"스캔 폴더 추가", removeAllScanFolders:"스캔 폴더 모두 제거",
    includeSubfolders:"하위 폴더 포함", includeSubfoldersDesc:"게임 실행파일 가능성이 있는 .exe만 표시합니다. setup, uninstall, Python/runtime, crash-handler 등 보조 실행파일은 제외합니다.", folderScanWarning:"폴더 스캔 경고", unregisteredExeFiles:"미등록 .exe 파일", addSelectedToSteam:"선택 항목 Steam에 추가 ({count})", markSelectedNotGame:"선택 항목 게임 아님으로 지정 ({count})", resultsTruncated:"검색 결과 일부만 표시", scanLimitReached:"백엔드 스캔 한도에 도달했습니다.", removeSelectedIgnored:"게임 아님 목록에서 선택 해제 ({count})",protonShortcutSettings:"바로가기 프로톤 설정", defaultProton:"기본 Proton", steamDefault:"Steam 기본값", chooseDefaultProton:"기본 Proton 선택", compatToolsUnavailable:"사용 가능한 호환성 도구가 없습니다.", shortcutVerified:"{name} 추가 및 검증 완료", shortcutUnverified:"{name}을 추가했지만 Steam 재확인에 실패했습니다", settings:"설정", scanSettings:"스캔 설정", folderAdded:"스캔 폴더를 추가했습니다", folderRemoved:"스캔 폴더를 제거했습니다", foldersCleared:"스캔 폴더를 모두 제거했습니다", clearFoldersTitle:"스캔 폴더를 모두 제거할까요?", clearFoldersDesc:"등록된 스캔 폴더 목록만 제거합니다. 실제 게임 파일은 삭제되지 않습니다.", delQueue:"모음집 정리", chooseDeleteCollection:"모음집 선택", deleteCollection:"모음집 정리", noCollections:"사용자 모음집이 없습니다.", delCollectionMissing:"선택한 모음집에 삭제 가능한 논스팀 바로가기가 없습니다.", deleteTarget:"삭제 대상 폴더", executablePath:"실행파일", pathWider:"← 경로 넓히기", pathNarrower:"경로 좁히기 →", deleteSelectedGames:"선택 게임 폴더 + 바로가기 삭제 ({count})", destructiveDeleteTitle:"게임 {count}개를 완전히 삭제할까요?", destructiveDeleteDesc:"선택한 실제 게임 폴더와 Steam 논스팀 바로가기를 함께 삭제합니다.", destructiveDeleteWarning:"실제 게임 파일이 영구 삭제됩니다. 아래 삭제 경로를 반드시 확인하세요.", otherShortcutWarning:"주의: 선택한 폴더 안을 사용하는 다른 바로가기 {count}개가 있습니다.", deleteGameFiles:"파일 + 바로가기 삭제", deleteCompleted:"{ok}개 삭제 완료, {failed}개 실패.", delCollectionReadFailed:"선택한 Steam 모음집을 읽지 못했습니다.", confirm:"확인"
  },
  ja: {
    pluginName:"ライブラリードクター", artworkUnknown:"アートワーク: 不明", artwork:"アートワーク", capsule:"カプセル", wide:"ワイド", hero:"ヒーロー", logo:"ロゴ", icon:"アイコン",
    folderBrowseFailed:"フォルダーの参照に失敗しました: {error}", chooseScanFolder:"スキャンフォルダーを選択", home:"ホーム", storage:"ストレージ", up:"上へ", loading:"読み込み中…", noChildFolders:"子フォルダーはありません。", useThisFolder:"このフォルダーを使用", cancel:"キャンセル",
    removeShortcutsTitle:"ショートカット {count} 件を削除しますか？", removeShortcutsDesc:"選択した Steam ショートカット {count} 件をライブラリから削除します。", gameFilesNotDeleted:"ゲームファイル自体は削除されません。Steam ショートカットのみ削除します。", removeShortcuts:"ショートカットを削除",
    notScannedYet:"未スキャン", settingsSaveFailed:"設定の保存に失敗しました: {error}", scanFailed:"スキャンに失敗しました: {error}", settingsLoadFailed:"設定の読み込みに失敗しました: {error}", backupFailed:"バックアップに失敗したため削除しませんでした。{error}", removedRefreshing:"ショートカット {count} 件を削除しました。再スキャン中…", removeFailed:"削除に失敗しました: {error}", steamRejected:"Steam が {name} の登録を拒否しました",
    addedWithFailures:"{ok} 件追加、{failed} 件失敗。", addedSuccess:"ショートカット {ok} 件を追加しました。",
    likelyGame:"ゲームの可能性 高", possibleGame:"ゲームの可能性 中", lowConfidence:"ゲームの可能性 低",
    scanning:"スキャン中…", stopScan:"スキャン停止", stoppingScan:"停止中…", scanStopped:"スキャンを停止しました", scanCurrent:"現在: {path}", scanProgress:"フォルダー {folders} · EXE {exes}", scanRoot:"検索ルート: {path}", scanFinalizing:"結果を整理中…", scanPhase:"段階: {phase}", scanElapsed:"経過 {elapsed}秒 · 段階 {phaseElapsed}秒 · 更新なし {stale}秒", scanDebug:"デバッグ: {detail}", scanStopRequested:"停止要求済み", libraryStatus:"ライブラリ状態", lastScan:"最終スキャン: {time}", ready:"準備完了", waiting:"待機中", scanNow:"今すぐスキャン",
    missing:"実行ファイルなし", duplicates:"重複", unregistered:"未登録 EXE", notAGame:"ゲームではない", libraryIssues:"ライブラリの問題", missingExecutable:"実行ファイルなし", removeSelected:"選択項目を削除 ({count})", storageOffline:"ストレージ未接続", invalidShortcuts:"無効なショートカット",
    duplicateGroups:"重複グループ", group:"グループ {index} · {count} 件", removeSelectedDuplicates:"選択した重複を削除 ({count})", exeDiscovery:"EXE 検出", scanFolders:"スキャンフォルダー", removeFolder:"{folder} を削除", addScanFolder:"スキャンフォルダーを追加", removeAllScanFolders:"スキャンフォルダーをすべて削除",
    includeSubfolders:"サブフォルダーを含める", includeSubfoldersDesc:"ゲーム実行ファイルの可能性がある .exe のみ表示します。setup、uninstall、Python/runtime、crash-handler などの補助実行ファイルは除外します。", folderScanWarning:"フォルダースキャン警告", unregisteredExeFiles:"未登録 .exe ファイル", addSelectedToSteam:"選択項目を Steam に追加 ({count})", markSelectedNotGame:"選択項目をゲームではないに設定 ({count})", resultsTruncated:"結果を一部省略", scanLimitReached:"バックエンドのスキャン上限に達しました。", removeSelectedIgnored:"ゲームではない一覧から選択項目を解除 ({count})",protonShortcutSettings:"ショートカット Proton 設定", defaultProton:"既定の Proton", steamDefault:"Steam の既定値", chooseDefaultProton:"既定の Proton を選択", compatToolsUnavailable:"利用可能な互換性ツールがありません。", shortcutVerified:"{name} を追加して確認しました", shortcutUnverified:"{name} を追加しましたが Steam の再確認に失敗しました", settings:"設定", scanSettings:"スキャン設定", folderAdded:"スキャンフォルダーを追加しました", folderRemoved:"スキャンフォルダーを削除しました", foldersCleared:"スキャンフォルダーをすべて削除しました", clearFoldersTitle:"すべてのスキャンフォルダーを削除しますか？", clearFoldersDesc:"監視フォルダーの登録だけを削除します。ゲームファイルは削除されません。", delQueue:"コレクション整理", chooseDeleteCollection:"コレクションを選択", deleteCollection:"コレクション整理", noCollections:"ユーザーコレクションがありません。", delCollectionMissing:"選択したコレクションに削除可能な非 Steam ショートカットがありません。", deleteTarget:"削除対象フォルダー", executablePath:"実行ファイル", pathWider:"← 上位へ", pathNarrower:"下位へ →", deleteSelectedGames:"選択したゲームフォルダー + ショートカットを削除 ({count})", destructiveDeleteTitle:"{count} ゲームを完全に削除しますか？", destructiveDeleteDesc:"選択したゲームフォルダーと Steam 非 Steam ショートカットを削除します。", destructiveDeleteWarning:"実際のゲームファイルが完全に削除されます。削除パスを確認してください。", otherShortcutWarning:"警告: 選択フォルダー内を使用する他のショートカットが {count} 件あります。", deleteGameFiles:"ファイル + ショートカットを削除", deleteCompleted:"{ok} 件削除、{failed} 件失敗。", delCollectionReadFailed:"選択した Steam コレクションを読み取れませんでした。", confirm:"確認"
  }
} as const;

type MessageKey = keyof typeof messages.en;
function detectUiLanguage():UiLanguage {
  const w=window as any;
  const candidates=[w.LocalizationManager?.m_strLanguage,w.LocalizationManager?.m_strELanguage,document.documentElement?.lang,navigator.language,...(navigator.languages??[])].filter(Boolean).map(String);
  const value=candidates.join(" ").toLowerCase();
  if(value.includes("koreana")||value.includes("korean")||/(^|[\s_-])ko([\s_-]|$)/.test(value))return "ko";
  if(value.includes("japanese")||/(^|[\s_-])ja([\s_-]|$)/.test(value))return "ja";
  return "en";
}
const UI_LANGUAGE:UiLanguage=detectUiLanguage();
function tr(key:MessageKey,vars:Record<string,string|number>={}):string {
  let value:string=messages[UI_LANGUAGE][key]??messages.en[key];
  return String(value).replace(/\{(\w+)\}/g,(_,name)=>String(vars[name]??`{${name}}`));
}

function sleep(ms:number){return new Promise(resolve=>setTimeout(resolve,ms));}
function artworkText(a?:ArtworkSummary){if(!a)return tr("artworkUnknown");const s=[a.capsule?tr("capsule"):null,a.wide?tr("wide"):null,a.hero?tr("hero"):null,a.logo?tr("logo"):null,a.icon?tr("icon"):null].filter(Boolean);return s.length?`${tr("artwork")} ${a.count}/5 · ${s.join(" · ")}`:`${tr("artwork")} 0/5`;}
function smartPathParts(path:string){
  const normalized=path.replace(/\\/g,"/").replace(/^\"|\"$/g,"");
  const isRemovable=normalized.startsWith("/run/media/")||normalized.startsWith("/media/")||normalized.startsWith("/mnt/");
  let compact=normalized;
  if(normalized.startsWith("/home/deck/")) compact=`~/${normalized.slice("/home/deck/".length)}`;
  else if(normalized==="/home/deck") compact="~";
  else if(normalized.startsWith("/run/media/deck/")){
    const rest=normalized.slice("/run/media/deck/".length);
    compact=rest;
  }else if(normalized.startsWith("/run/media/")){
    compact=normalized.slice("/run/media/".length);
  }
  const idx=compact.lastIndexOf("/");
  return {badge:isRemovable?"SD":"SSD",dir:idx>=0?compact.slice(0,idx+1):"",file:idx>=0?compact.slice(idx+1):compact};
}
function shortDisplayPath(path:string){const normalized=(path||"").replace(/\\/g,"/");if(normalized.startsWith("/home/deck/"))return "~/"+normalized.slice(11);if(normalized.startsWith("/run/media/deck/"))return normalized.slice(16);return normalized;}

function PathWithBoldFilename({path}:{path:string}){const {badge,dir,file}=smartPathParts(path);return <span style={{display:"inline-flex",alignItems:"baseline",gap:"5px",maxWidth:"100%"}}><span aria-hidden="true" style={{display:"inline-flex",alignItems:"center",justifyContent:"center",minWidth:"25px",height:"13px",padding:"0 3px",borderRadius:"3px",boxSizing:"border-box",fontSize:"7.5px",lineHeight:"13px",fontWeight:800,letterSpacing:".15px",color:"rgba(255,255,255,.82)",background:"rgba(255,255,255,.10)",border:"1px solid rgba(255,255,255,.16)",flex:"0 0 auto"}}>{badge}</span><span style={{minWidth:0,wordBreak:"break-all"}}>{dir}<strong style={{fontWeight:800,color:"rgba(255,255,255,.82)"}}>{file}</strong></span></span>;}


function collectionBucketToIds(bucket:any):number[]{
  const ids=new Set<number>();
  const add=(value:any)=>{
    if(value==null)return;
    const direct=typeof value==="object"?(value?.appid??value?.appId??value?.nAppID??value?.m_nAppID):value;
    const n=Number(direct);
    if(Number.isFinite(n)&&n!==0)ids.add(n>>>0);
  };
  if(!bucket)return [];
  if(bucket instanceof Map){for(const [k,v] of bucket){add(k);if(ids.size===0)add(v);}return [...ids];}
  if(bucket instanceof Set||Array.isArray(bucket)){for(const v of bucket)add(v);return [...ids];}
  try{
    if(typeof bucket?.[Symbol.iterator]==="function"){
      for(const v of bucket)add(v);
      return [...ids];
    }
  }catch{}
  // Steam/MobX can expose array-like collection buckets without passing instanceof checks.
  if(typeof bucket?.length==="number"){
    for(let i=0;i<bucket.length;i++)add(bucket[i]);
    return [...ids];
  }
  return [...ids];
}
function collectionBucketsToIds(collection:any):number[]{
  // Steam's collection tile count is based on apps that currently resolve to an
  // AppOverview, not every historical id still left in the collection internals.
  // Prefer visible/all app overview lists so our picker matches the Steam UI.
  for(const bucket of [collection?.visibleApps,collection?.allApps]){
    const ids=collectionBucketToIds(bucket);
    if(ids.length)return ids;
  }

  // Fall back to raw membership, but discard orphaned AppIDs whose shortcuts no
  // longer exist. Older Library Doctor builds could leave these behind when a
  // shortcut was removed before collection membership was updated.
  const rawBuckets=[
    collection?.apps,
    collection?.m_setApps,
    collection?.m_rgApps,
    collection?.internalAddedList,
    collection?.m_setAddedManually,
    collection?.added,
    collection?.appids,
    collection?.appIds,
    collection?.rgAppIDs,
    collection?.m_rgAppIDs,
  ];
  for(const bucket of rawBuckets){
    const ids=collectionBucketToIds(bucket);
    if(ids.length){
      const appStore=(window as any)?.appStore;
      if(appStore?.GetAppOverviewByAppID){
        const valid=ids.filter(id=>{try{return Boolean(appStore.GetAppOverviewByAppID(id));}catch{return false;}});
        if(valid.length||ids.length)return valid;
      }
      return ids;
    }
  }
  try{
    const drag=collection?.AsDragDropCollection?.();
    for(const bucket of [drag?.visibleApps,drag?.allApps,drag?.apps]){
      const ids=collectionBucketToIds(bucket);
      if(ids.length){
        const appStore=(window as any)?.appStore;
        if(appStore?.GetAppOverviewByAppID)return ids.filter(id=>{try{return Boolean(appStore.GetAppOverviewByAppID(id));}catch{return false;}});
        return ids;
      }
    }
  }catch{}
  return [];
}

function listUserCollections():UserCollectionSummary[]{
  try{
    const store=((window as any)?.collectionStore??(globalThis as any)?.collectionStore) as any;
    if(!store)return [];
    const toArray=(value:any):any[]=>{
      if(!value)return [];
      if(Array.isArray(value))return value;
      if(value instanceof Set||value instanceof Map)return [...value.values()];
      try{if(typeof value?.[Symbol.iterator]==="function")return [...value];}catch{}
      if(typeof value==="object")return Object.values(value);
      return [];
    };
    const out:UserCollectionSummary[]=[];
    for(const candidate of toArray(store.userCollections)){
      let collection=candidate;
      try{
        const candidateId=typeof candidate==="string"?candidate:candidate?.id??candidate?.m_strId;
        if((!candidate?.displayName&&!candidate?.m_strName)&&candidateId&&typeof store.GetCollection==="function")collection=store.GetCollection(candidateId)??candidate;
      }catch{}
      const id=String(collection?.id??collection?.m_strId??"").trim();
      const name=String(collection?.displayName??collection?.name??collection?.m_strName??id).trim();
      if(!id||!name)continue;
      out.push({id,name,appIds:collectionBucketsToIds(collection)});
    }
    return out.sort((a,b)=>a.name.localeCompare(b.name));
  }catch{return [];}
}
async function removeAppsFromCollection(collectionId:string,appIds:number[]):Promise<void>{
  if(!collectionId||!appIds.length)return;
  try{
    const store=((window as any)?.collectionStore??(globalThis as any)?.collectionStore) as any;
    if(!store)return;
    const collection=store?.GetCollection?.(collectionId)??(()=>{
      try{
        const values=Array.isArray(store.userCollections)?store.userCollections:[...(store.userCollections??[])];
        return values.find((c:any)=>String(c?.id??c?.m_strId??"")===collectionId);
      }catch{return undefined;}
    })();
    if(!collection)return;
    const overviews=Array.from(new Set(appIds.map(id=>id>>>0)))
      .map(id=>(window as any)?.appStore?.GetAppOverviewByAppID?.(id))
      .filter(Boolean);
    if(!overviews.length)return;
    const target=collection?.AsDragDropCollection?.()??collection;
    if(typeof target?.RemoveApps==="function"){
      target.RemoveApps(overviews);
      // RemoveApps triggers Save on current Steam builds, but explicitly await
      // Save as well so collection membership is flushed before shortcuts vanish.
      if(typeof collection?.Save==="function")await collection.Save();
    }
  }catch(error){
    console.warn("[Library Doctor] could not remove apps from collection",error);
  }
}

function readCollectionAppIds(collectionId:string):number[]{
  if(!collectionId)return [];
  const direct=listUserCollections().find(c=>c.id===collectionId);
  if(direct)return direct.appIds;
  try{
    const store=((window as any)?.collectionStore??(globalThis as any)?.collectionStore) as any;
    const collection=store?.GetCollection?.(collectionId);
    return collectionBucketsToIds(collection);
  }catch{return [];}
}

function ActionButton({children,onClick,disabled=false,tone="neutral"}:{children:React.ReactNode;onClick:()=>void;disabled?:boolean;tone?:keyof typeof actionColors}){
  const [focused,setFocused]=useState(false);
  const normalText=tone==="neutral"?"rgba(255,255,255,.92)":actionColors[tone];
  return <Focusable noFocusRing onGamepadFocus={()=>setFocused(true)} onGamepadBlur={()=>setFocused(false)} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)} style={{width:"100%",minWidth:0}}>
    <DialogButton
      onClick={onClick}
      disabled={disabled}
      style={{width:"100%",minWidth:0,minHeight:"34px",height:"34px",margin:"3px 0",padding:"2px 10px",display:"flex",alignItems:"center",justifyContent:"center",borderRadius:"7px",fontSize:"12.5px",fontWeight:700,borderLeft:disabled?undefined:`3px solid ${actionColors[tone]}`}}
    ><span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",color:disabled?undefined:(focused?"#111":normalText),fontWeight:800,textShadow:focused?"none":(tone==="neutral"?undefined:"0 1px 2px rgba(0,0,0,.55)"),transition:"color .08s ease"}}>{children}</span></DialogButton>
  </Focusable>;
}
function CompactIconButton({label,onClick,disabled=false,tone="danger",children}:{label:string;onClick:()=>void;disabled?:boolean;tone?:keyof typeof actionColors;children:React.ReactNode}){
  const [focused,setFocused]=useState(false);
  return <Focusable noFocusRing onGamepadFocus={()=>setFocused(true)} onGamepadBlur={()=>setFocused(false)} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)} style={{width:"34px",minWidth:"34px",height:"32px",flex:"0 0 34px"}}>
    <DialogButton
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      style={{width:"34px",minWidth:"34px",height:"32px",minHeight:"32px",padding:0,margin:0,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:"6px",boxSizing:"border-box",color:disabled?undefined:"#fff",background:disabled?undefined:(focused?"rgba(255,255,255,.18)":actionBackgrounds[tone]),border:`${focused?2:1}px solid ${disabled?"transparent":(focused?"#fff":actionBorders[tone])}`,boxShadow:focused?"0 0 0 1px rgba(255,255,255,.22), 0 0 10px rgba(255,255,255,.18)":"none"}}
    >{children}</DialogButton>
  </Focusable>;
}
function SettingsIconButton({label,onClick,disabled=false}:{label:string;onClick:()=>void;disabled?:boolean}){
  const [focused,setFocused]=useState(false);
  return <Focusable noFocusRing onGamepadFocus={()=>setFocused(true)} onGamepadBlur={()=>setFocused(false)} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)} style={{width:"26px",minWidth:"26px",height:"26px",flex:"0 0 26px"}}>
    <DialogButton aria-label={label} disabled={disabled} onClick={onClick} style={{width:"26px",minWidth:"26px",height:"26px",minHeight:"26px",padding:0,margin:0,borderRadius:"5px",boxSizing:"border-box",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"11px",color:disabled?undefined:"#fff",background:focused?"rgba(255,255,255,.18)":"rgba(255,255,255,.055)",border:`${focused?2:1}px solid ${focused?"#fff":"rgba(255,255,255,.10)"}`,boxShadow:focused?"0 0 0 1px rgba(255,255,255,.22), 0 0 10px rgba(255,255,255,.18)":"none"}}><FaCog/></DialogButton>
  </Focusable>;
}
function ModalActionButton({children,onClick,disabled=false,tone="neutral"}:{children:React.ReactNode;onClick:()=>void;disabled?:boolean;tone?:keyof typeof actionColors}){
  return <DialogButton
    disabled={disabled}
    onClick={onClick}
    style={{flex:"1 1 0",minWidth:0,height:"42px",margin:0,padding:"0 12px",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"12.5px",fontWeight:700,color:disabled?undefined:"#fff",background:disabled?undefined:actionBackgrounds[tone],border:`1px solid ${disabled?"transparent":actionBorders[tone]}`,borderRadius:"7px"}}
  >{children}</DialogButton>;
}
function SectionToggle({open,label,count,onClick,tone="neutral"}:{open:boolean;label:string;count?:number;onClick:()=>void;tone?:keyof typeof actionColors}){return <DialogButton onClick={onClick} style={{width:"100%",minWidth:0,minHeight:"34px",height:"34px",margin:"4px 0",padding:"2px 10px",display:"flex",alignItems:"center",justifyContent:"flex-start",borderRadius:"7px",textAlign:"left",borderLeft:`3px solid ${actionColors[tone]}`}}><span style={{...sectionText}}>{open?"▾":"▸"} {label}{count!=null?` (${count})`:""}</span></DialogButton>;}

type NavOrientation = "horizontal" | "vertical";
function DirectionalNavZone({orientation,children,lockCross=false,className,style}:{orientation:NavOrientation;children:React.ReactNode;lockCross?:boolean;className?:string;style?:React.CSSProperties}){
  const flow=orientation==="horizontal"?"right":"down";
  return <Focusable
    className={className}
    flow-children={flow}
    style={style}
    onGamepadDirection={lockCross?(evt)=>{
      const button=evt.detail?.button;
      const cross=orientation==="horizontal"?(button===GamepadButton.DIR_UP||button===GamepadButton.DIR_DOWN):(button===GamepadButton.DIR_LEFT||button===GamepadButton.DIR_RIGHT);
      if(cross){evt.preventDefault();evt.stopPropagation();}
    }:undefined}
  >{children}</Focusable>;
}

function FolderBrowser({initialPath,onSelect,onClose}:{initialPath:string;onSelect:(path:string)=>void;onClose:()=>void}){
  const [listing,setListing]=useState<FolderListing|null>(null);
  const [busy,setBusy]=useState(false);
  const load=useCallback(async(path:string)=>{setBusy(true);try{setListing(await listDirectories(path));}catch(e){toaster.toast({title:tr("pluginName"),body:tr("folderBrowseFailed",{error:String(e)})});}finally{setBusy(false);}},[]);
  useEffect(()=>{void load(initialPath||"/home/deck");},[initialPath,load]);
  return <Focusable flow-children="down" style={{minWidth:"560px",maxWidth:"760px",padding:"8px 12px 16px"}}>
    <h2 style={{margin:"4px 0 6px"}}>{tr("chooseScanFolder")}</h2>
    <div style={{fontSize:"10px",opacity:.62,wordBreak:"break-all",marginBottom:"10px"}}>{listing?.error||listing?.path||initialPath}</div>
    <DirectionalNavZone orientation="horizontal" style={{display:"flex",flexDirection:"row",gap:"8px",width:"100%",marginBottom:"10px"}}>
      <ModalActionButton tone="neutral" onClick={()=>void load("/home/deck")}>{tr("home")}</ModalActionButton>
      <ModalActionButton tone="neutral" onClick={()=>void load("/run/media/deck")}>{tr("storage")}</ModalActionButton>
      <ModalActionButton tone="neutral" onClick={()=>void load(listing?.parent||"/")} disabled={!listing||listing.path==="/"}>{tr("up")}</ModalActionButton>
    </DirectionalNavZone>
    <DirectionalNavZone orientation="vertical" style={{maxHeight:"54vh",overflowY:"auto"}}>
      {busy&&<div style={{padding:"12px"}}>{tr("loading")}</div>}
      {!busy&&listing?.folders.map(f=><ButtonItem key={f.path} layout="below" onClick={()=>void load(f.path)}><span style={{...textStyle,display:"flex",alignItems:"center",gap:"8px"}}><FaFolder/>{f.name}</span></ButtonItem>)}
      {!busy&&listing&&listing.folders.length===0&&<div style={{padding:"12px",opacity:.7}}>{tr("noChildFolders")}</div>}
    </DirectionalNavZone>
    <DirectionalNavZone orientation="horizontal" style={{display:"flex",flexDirection:"row",gap:"8px",width:"100%",marginTop:"12px"}}>
      <ModalActionButton tone="success" onClick={()=>listing&&onSelect(listing.path)} disabled={!listing||!!listing.error}>{tr("useThisFolder")}</ModalActionButton>
      <ModalActionButton tone="neutral" onClick={onClose}>{tr("cancel")}</ModalActionButton>
    </DirectionalNavZone>
  </Focusable>;
}

function showDeleteConfirm(ids:number[],onConfirm:()=>void){
  const Content=({closeModal}:{closeModal?:()=>void})=><ModalRoot onCancel={()=>closeModal?.()}>
    <div style={{padding:"10px 16px 18px",minWidth:"520px",maxWidth:"680px"}}>
      <h2>{tr("removeShortcutsTitle",{count:ids.length})}</h2>
      <p style={{fontSize:"14px",lineHeight:1.45}}>{tr("removeShortcutsDesc",{count:ids.length})}</p>
      <p style={{fontSize:"14px",lineHeight:1.45,color:actionColors.danger,fontWeight:700}}>{tr("gameFilesNotDeleted")}</p>
      <DirectionalNavZone orientation="horizontal" lockCross style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px",marginTop:"16px",width:"100%",alignItems:"stretch"}}>
        <DialogButton onClick={()=>closeModal?.()} style={{width:"100%",minWidth:0,margin:0}}>{tr("cancel")}</DialogButton>
        <DialogButton onClick={()=>{closeModal?.();onConfirm();}} style={{width:"100%",minWidth:0,margin:0,color:actionColors.danger,fontWeight:700}}>{tr("removeShortcuts")}</DialogButton>
      </DirectionalNavZone>
    </div>
  </ModalRoot>;
  showModal(<Content/>);
}

function scanPhaseLabel(phase?:string):string {
  const labels:Record<string,Record<UiLanguage,string>>={
    starting:{en:"Starting",ko:"시작",ja:"開始"},
    shortcut_files:{en:"Locate shortcut files",ko:"바로가기 파일 찾기",ja:"ショートカットファイル検索"},
    read_shortcuts:{en:"Read shortcuts",ko:"바로가기 읽기",ja:"ショートカット読込"},
    dedup_shortcuts:{en:"Deduplicate shortcuts",ko:"바로가기 중복 정리",ja:"ショートカット重複整理"},
    load_settings:{en:"Load settings",ko:"설정 읽기",ja:"設定読込"},
    duplicate_groups:{en:"Find duplicates",ko:"중복 바로가기 계산",ja:"重複計算"},
    duplicate_roots:{en:"Resolve duplicate roots",ko:"중복 게임 경로 계산",ja:"重複ゲームパス計算"},
    prepare_folder_scan:{en:"Prepare folder scan",ko:"폴더 스캔 준비",ja:"フォルダスキャン準備"},
    walking:{en:"Scan folders",ko:"폴더 탐색",ja:"フォルダ探索"},
    sort_unregistered:{en:"Sort discovered EXEs",ko:"발견 EXE 정렬",ja:"検出EXE整理"},
    filter_ignored:{en:"Apply ignore list",ko:"게임 아님 목록 적용",ja:"除外リスト適用"},
    build_result:{en:"Build results",ko:"결과 생성",ja:"結果生成"},
    returning:{en:"Return results",ko:"결과 전송",ja:"結果送信"},
    idle:{en:"Idle",ko:"대기",ja:"待機"},
  };
  return labels[phase||""]?.[UI_LANGUAGE]??phase??"-";
}

function Content(){
  const [result,setResult]=useState<ScanResult|null>(null);
  const [selected,setSelected]=useState<Set<number>>(new Set());
  const [selectedDuplicates,setSelectedDuplicates]=useState<Set<number>>(new Set());
  const [selectedUnregistered,setSelectedUnregistered]=useState<Set<string>>(new Set());
  const [selectedIgnored,setSelectedIgnored]=useState<Set<string>>(new Set());
  const [ignoredExecutables,setIgnoredExecutables]=useState<string[]>([]);
  const [watchedFolders,setWatchedFolders]=useState<string[]>([]);
  const [recursiveFolderScan,setRecursiveFolderScan]=useState(true);
  const [busy,setBusy]=useState(false);
  const [scanning,setScanning]=useState(false);
  const [stoppingScan,setStoppingScan]=useState(false);
  const [scanStatus,setScanStatus]=useState<ScanStatus|null>(null);
  const [uiScanDebug,setUiScanDebug]=useState<string>("idle");
  const [lastScanLabel,setLastScanLabel]=useState(tr("notScannedYet"));
  const [artworkPreviews,setArtworkPreviews]=useState<Record<number,ArtworkPreviewBundle>>({});
  const [compatTools,setCompatTools]=useState<CompatibilityTool[]>([]);
  const [defaultCompatTool,setDefaultCompatTool]=useState("");
  const [openGroups,setOpenGroups]=useState({missing:false,offline:false,invalid:false,duplicates:false,folders:false,unregistered:false,ignored:false,del:false});
  const [openDuplicateGames,setOpenDuplicateGames]=useState<Set<string>>(new Set());
  const [openUnregisteredGames,setOpenUnregisteredGames]=useState<Set<string>>(new Set());
  const [collections,setCollections]=useState<UserCollectionSummary[]>([]);
  const [selectedCollectionId,setSelectedCollectionId]=useState("");
  const [delEntries,setDelEntries]=useState<DelEntry[]>([]);
  const [selectedDel,setSelectedDel]=useState<Set<number>>(new Set());
  const [openDelGame,setOpenDelGame]=useState<number|null>(null);
  const [storageSummary,setStorageSummary]=useState<StorageSummary|null>(null);
  const [storageBusy,setStorageBusy]=useState(false);
  const [storageLimit,setStorageLimit]=useState(30);
  const [selectedStorage,setSelectedStorage]=useState<Set<string>>(new Set());
  const [openStorageGroups,setOpenStorageGroups]=useState<Set<string>>(new Set());
  const [focusedDashboardCard,setFocusedDashboardCard]=useState<"missing"|"duplicates"|"unregistered"|"ignored"|null>(null);
  const missingSectionRef=useRef<HTMLDivElement|null>(null);
  const duplicateSectionRef=useRef<HTMLDivElement|null>(null);
  const unregisteredSectionRef=useRef<HTMLDivElement|null>(null);
  const ignoredSectionRef=useRef<HTMLDivElement|null>(null);
  const delSectionRef=useRef<HTMLDivElement|null>(null);
  const scanInFlight=useRef(false);
  const sessionAddedPaths=useRef<Set<string>>(new Set());

  const itemsByStatus=useMemo(()=>{const byPath=(a:ShortcutItem,b:ShortcutItem)=>a.exe.localeCompare(b.exe)||a.name.localeCompare(b.name);return {
    missing:(result?.items.filter(x=>x.status==="missing"&&!x.utilityShortcut)??[]).sort(byPath),
    offline:(result?.items.filter(x=>x.status==="storage_offline"&&!x.utilityShortcut)??[]).sort(byPath),
    invalid:(result?.items.filter(x=>x.status==="invalid"&&!x.utilityShortcut)??[]).sort(byPath),
  };},[result]);

  const storageGroups=useMemo(()=>{
    const groups=[
      {key:"internal",label:storageLabel("internal"),games:[] as StorageGame[],bytes:0},
      {key:"removable",label:storageLabel("removable"),games:[] as StorageGame[],bytes:0},
    ];
    for(const game of storageSummary?.games??[]){
      const target=game.storageRoot?groups[1]:groups[0];
      target.games.push(game);
      target.bytes+=game.sizeBytes;
    }
    return groups.filter(g=>g.games.length>0);
  },[storageSummary]);
  const selectedStorageGames=useMemo(()=>storageSummary?.games.filter(g=>selectedStorage.has(g.root))??[],[storageSummary,selectedStorage]);
  const selectedStorageBytes=useMemo(()=>selectedStorageGames.reduce((sum,g)=>sum+g.sizeBytes,0),[selectedStorageGames]);

  const persistSettings=useCallback(async(w:string[],r:boolean,ignored:string[]=ignoredExecutables,compatTool:string=defaultCompatTool)=>{try{const saved=await saveSettings(w,r,ignored,compatTool);setWatchedFolders(saved.watchedFolders);setRecursiveFolderScan(saved.recursiveFolderScan);setIgnoredExecutables(saved.ignoredExecutables??[]);setDefaultCompatTool(saved.defaultCompatTool??"");}catch(e){toaster.toast({title:tr("pluginName"),body:tr("settingsSaveFailed",{error:String(e)})});}},[ignoredExecutables,defaultCompatTool]);
  const commitScanResult=useCallback(async(data:ScanResult)=>{const parentDir=(value:string)=>value.replace(/\\/g,"/").replace(/\/[^/]+$/,"");const visibleUnregistered=data.unregisteredExecutables.filter(x=>!sessionAddedPaths.current.has(x.path)).sort((a,b)=>parentDir(a.path).localeCompare(parentDir(b.path))||b.candidateScore-a.candidateScore||a.name.localeCompare(b.name)||a.path.localeCompare(b.path));const normalized={...data,unregisteredExecutables:visibleUnregistered};setResult(normalized);setSelected(new Set());setSelectedDuplicates(new Set());setSelectedUnregistered(new Set());setSelectedIgnored(new Set());setWatchedFolders(data.watchedFolders??[]);setLastScanLabel(new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}));},[]);
  const activeScanIdRef=useRef<number>(0);
  const handledScanIdRef=useRef<number>(0);
  const finishUiScan=useCallback(()=>{scanInFlight.current=false;setScanning(false);setStoppingScan(false);setBusy(false);setUiScanDebug("idle");},[]);
  const scan=useCallback(async()=>{if(scanInFlight.current)return;scanInFlight.current=true;setBusy(true);setScanning(true);setStoppingScan(false);setUiScanDebug("UI-01 startScan 호출");setResult(null);setLastScanLabel(tr("notScannedYet"));setSelected(new Set());setSelectedDuplicates(new Set());setSelectedUnregistered(new Set());setSelectedIgnored(new Set());try{const started=await startScan();activeScanIdRef.current=started.scanId;handledScanIdRef.current=0;setUiScanDebug(`UI-02 scanId ${started.scanId} · 상태 폴링`);}catch(e){finishUiScan();toaster.toast({title:tr("pluginName"),body:tr("scanFailed",{error:String(e)})});}},[finishUiScan]);
  const requestStopScan=useCallback(async()=>{if(!scanInFlight.current||stoppingScan)return;setStoppingScan(true);try{await stopScan();}catch(e){console.warn("[LibraryDoctor] stop_scan failed",e);setStoppingScan(false);}},[stoppingScan]);
  const waitForScanIdle=useCallback(async()=>{for(let i=0;i<80&&scanInFlight.current;i++)await sleep(50);},[]);
  const refreshAfterRemoval=useCallback(async(ids:number[])=>{const removed=new Set(ids);let latest:ScanResult|null=null;for(const delay of POST_REMOVE_DELAYS_MS){await sleep(delay);latest=await scanShortcuts();if(!latest.items.some(i=>i.appId!=null&&removed.has(i.appId)))break;}if(latest)await commitScanResult(latest);},[commitScanResult]);

  useEffect(()=>{let cancelled=false;void(async()=>{try{const s=await getSettings();if(cancelled)return;setWatchedFolders(s.watchedFolders??[]);setRecursiveFolderScan(s.recursiveFolderScan);setIgnoredExecutables(s.ignoredExecutables??[]);setDefaultCompatTool(s.defaultCompatTool??"");}catch(e){if(!cancelled)toaster.toast({title:tr("pluginName"),body:tr("settingsLoadFailed",{error:String(e)})});}})();return()=>{cancelled=true};},[]);
  useEffect(()=>{
    if(!scanning){setScanStatus(null);return;}
    let cancelled=false;
    let fetchingResult=false;
    const poll=async()=>{
      if(fetchingResult)return;
      try{
        const status=await getScanStatus();
        if(cancelled)return;
        setScanStatus(status);
        const wanted=activeScanIdRef.current||status.scanId;
        if(status.scanId!==wanted)return;
        const hasStoredResult=Boolean(status.resultReady||status.resultStored);
        if(!fetchingResult&&handledScanIdRef.current!==wanted){
          if(status.resultError){
            handledScanIdRef.current=wanted;
            finishUiScan();
            toaster.toast({title:tr("pluginName"),body:tr("scanFailed",{error:status.resultError})});
            return;
          }
          if(hasStoredResult){
            fetchingResult=true;
            setUiScanDebug(`UI-03 결과 감지 · getScanResult(${wanted}) 호출`);
            try{
              // Stop overlapping status RPCs while the result payload is in flight.
              // Some Decky builds can leave a large result promise unresolved when
              // status polling continues on the same bridge. The backend pre-serializes
              // the payload so the bridge only needs to carry one string.
              const payload=await getScanResultJson(wanted);
              setUiScanDebug(`UI-04 JSON 응답 수신 · ${payload.length} chars`);
              if(cancelled)return;
              const envelope=JSON.parse(payload) as ScanResultEnvelope;
              setUiScanDebug(`UI-05 JSON 파싱 완료 · ready=${String(envelope.ready)}`);
              if(envelope.error)throw new Error(envelope.error);
              if(envelope.ready&&envelope.result){
                handledScanIdRef.current=wanted;
                setUiScanDebug(`UI-06 결과 적용 시작`);
                if(envelope.result.scanCancelled)toaster.toast({title:tr("pluginName"),body:tr("scanStopped")});
                else await commitScanResult(envelope.result);
                finishUiScan();
              }
            }catch(e){
              if(!cancelled){handledScanIdRef.current=wanted;finishUiScan();toaster.toast({title:tr("pluginName"),body:tr("scanFailed",{error:String(e)})});}
            }finally{fetchingResult=false;}
          }
        }
      }catch{}
    };
    void poll();
    const timer=setInterval(()=>void poll(),250);
    return()=>{cancelled=true;clearInterval(timer);};
  },[scanning,commitScanResult,finishUiScan]);
  useEffect(()=>{void(async()=>{try{const tools=await (SteamClient.Settings as any).GetGlobalCompatTools();setCompatTools((tools??[]).filter((x:any)=>x?.strToolName).map((x:any)=>({strToolName:String(x.strToolName),strDisplayName:String(x.strDisplayName||x.strToolName)})));}catch{setCompatTools([]);}})();},[]);
  useEffect(()=>{if(!result)return;const ids=Array.from(new Set(result.duplicateGroups.flatMap(g=>g.items.map(i=>i.appId).filter((id):id is number=>id!=null))));if(!ids.length){setArtworkPreviews({});return;}let cancelled=false;setArtworkPreviews({});void(async()=>{const p:Record<number,ArtworkPreviewBundle>={};for(const id of ids){try{p[id]=await getArtworkPreview(id);}catch(e){p[id]={items:[],error:String(e)}}if(!cancelled)setArtworkPreviews({...p});}})();return()=>{cancelled=true};},[result]);

  const closeAllExpandableGroups=()=>{
    setOpenGroups({missing:false,offline:false,invalid:false,duplicates:false,folders:false,unregistered:false,ignored:false,del:false});
    setOpenDuplicateGames(new Set());
    setOpenUnregisteredGames(new Set());
    setOpenDelGame(null);
  };
  const toggleGroup=(key:keyof typeof openGroups)=>{
    setOpenDuplicateGames(new Set());
    setOpenUnregisteredGames(new Set());
    setOpenDelGame(null);
    setOpenGroups(v=>{const willOpen=!v[key];return {missing:false,offline:false,invalid:false,duplicates:false,folders:false,unregistered:false,ignored:false,del:false,[key]:willOpen};});
  };
  const toggleDuplicateGame=(key:string)=>{
    setOpenDelGame(null);
    setOpenGroups({missing:false,offline:false,invalid:false,duplicates:false,folders:false,unregistered:false,ignored:false,del:false});
    setOpenUnregisteredGames(new Set());
    setOpenDuplicateGames(cur=>cur.has(key)?new Set():new Set([key]));
  };
  const toggleUnregisteredGame=(key:string)=>{
    setOpenDelGame(null);
    setOpenGroups({missing:false,offline:false,invalid:false,duplicates:false,folders:false,unregistered:false,ignored:false,del:false});
    setOpenDuplicateGames(new Set());
    setOpenUnregisteredGames(cur=>cur.has(key)?new Set():new Set([key]));
  };
  const jumpToSection=(key:"missing"|"duplicates"|"unregistered"|"ignored",ref:React.RefObject<HTMLDivElement|null>)=>{
    setFocusedDashboardCard(null);
    closeAllExpandableGroups();
    if(key==="missing"||key==="ignored")setOpenGroups({missing:key==="missing",offline:false,invalid:false,duplicates:false,folders:false,unregistered:false,ignored:key==="ignored",del:false});
    window.setTimeout(()=>{
      const section=ref.current;
      if(!section)return;
      section.scrollIntoView({behavior:"smooth",block:"start"});
      window.setTimeout(()=>{
        const focusTarget=section.querySelector<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"]):not([aria-disabled="true"])');
        focusTarget?.focus();
      },140);
    },80);
  };
  const toggleItem=(item:ShortcutItem)=>{if(item.appId==null||item.status==="storage_offline")return;setSelected(cur=>{const n=new Set(cur);n.has(item.appId!)?n.delete(item.appId!):n.add(item.appId!);return n;});};
  const toggleDuplicate=(item:ShortcutItem)=>{if(item.appId==null)return;setSelectedDuplicates(cur=>{const n=new Set(cur);n.has(item.appId!)?n.delete(item.appId!):n.add(item.appId!);return n;});};
  const toggleUnregistered=(path:string)=>setSelectedUnregistered(cur=>{const n=new Set(cur);n.has(path)?n.delete(path):n.add(path);return n;});
  const toggleIgnored=(path:string)=>setSelectedIgnored(cur=>{const n=new Set(cur);n.has(path)?n.delete(path):n.add(path);return n;});

  const removeShortcutsReliably=async(ids:number[])=>{
    const unique=Array.from(new Set(ids));
    for(const id of unique){
      try{
        const maybePromise=(SteamClient.Apps as any).RemoveShortcut(id);
        if(maybePromise&&typeof maybePromise.then==="function")await maybePromise;
      }catch(e){
        console.warn(`[LibraryDoctor] RemoveShortcut(${id}) failed`,e);
      }
      // Steam drops back-to-back RemoveShortcut IPC calls on some client builds.
      // A short gap lets each shortcut mutation settle before the next one.
      if(unique.length>1)await sleep(MULTI_REMOVE_GAP_MS);
    }
  };
  const loadStorage=async(force=false)=>{
    if(storageBusy)return;
    setStorageBusy(true);
    try{
      const summary=await getLibraryStorage(force);
      setStorageSummary(summary);
      setStorageLimit(30);
      setSelectedStorage(new Set());
      setOpenStorageGroups(new Set());
    }catch(e){
      toaster.toast({title:tr("pluginName"),body:String(e)});
    }finally{setStorageBusy(false);}
  };
  const deleteStorageGame=async(game:StorageGame)=>{
    if(storageBusy||!game.canDelete)return;
    const Confirm=({closeModal}:{closeModal?:()=>void})=><ModalRoot onCancel={()=>closeModal?.()}><div style={{padding:"10px 16px 18px",minWidth:"520px",maxWidth:"700px"}}><h2>{storageLabel("deleteTitle")}</h2><div style={{fontSize:"14px",fontWeight:800,margin:"8px 0"}}>{game.name} · {formatBytes(game.sizeBytes)}</div><div style={{fontSize:"10px",opacity:.65,wordBreak:"break-all",marginBottom:"10px"}}>{game.root}</div><p style={{fontSize:"13px",lineHeight:1.45,color:actionColors.danger,fontWeight:800}}>{storageLabel("deleteWarn")}</p><DirectionalNavZone orientation="horizontal" lockCross style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px",marginTop:"14px"}}><DialogButton onClick={()=>closeModal?.()}>{tr("cancel")}</DialogButton><DialogButton onClick={()=>{closeModal?.();void (async()=>{setStorageBusy(true);try{const backup=await backupShortcuts();if(!backup.success)throw new Error(backup.error||"Backup failed");const removed=await deleteGameDirectory(game.root,game.exe);if(!removed.success)throw new Error(removed.error||storageLabel("failed"));if(game.appIds.length)await removeShortcutsReliably(game.appIds);setResult(null);setLastScanLabel(tr("notScannedYet"));setSelected(new Set());setSelectedDuplicates(new Set());setSelectedUnregistered(new Set());setSelectedIgnored(new Set());setDelEntries([]);setSelectedDel(new Set());setOpenDelGame(null);const refreshed=await getLibraryStorage(true);setStorageSummary(refreshed);toaster.toast({title:tr("pluginName"),body:`${storageLabel("freed")} ${formatBytes(game.sizeBytes)}`});}catch(e){toaster.toast({title:tr("pluginName"),body:`${storageLabel("failed")}: ${String(e)}`});}finally{setStorageBusy(false);}})();}} style={{color:actionColors.danger,fontWeight:800}}>{storageLabel("delete")}</DialogButton></DirectionalNavZone></div></ModalRoot>;
    showModal(<Confirm/>);
  };

  const deleteSelectedStorageGames=async()=>{
    const targets=selectedStorageGames.filter(game=>game.canDelete);
    if(!targets.length)return;
    const Confirm=({closeModal}:{closeModal?:()=>void})=><ModalRoot onCancel={()=>closeModal?.()}><div style={{padding:"10px 16px 18px",minWidth:"540px",maxWidth:"720px"}}><h2>{storageLabel("deleteTitle")}</h2><div style={{fontSize:"14px",fontWeight:900,margin:"8px 0"}}>{storageLabel("selected")} {targets.length} · {formatBytes(targets.reduce((s,g)=>s+g.sizeBytes,0))}</div><p style={{fontSize:"13px",lineHeight:1.45,color:actionColors.danger,fontWeight:800}}>{storageLabel("deleteWarn")}</p><div style={{maxHeight:"32vh",overflowY:"auto"}}>{targets.map(game=><div key={game.root} style={{padding:"5px 7px",margin:"3px 0",borderRadius:"6px",background:"rgba(255,255,255,.035)"}}><div style={{fontSize:"11px",fontWeight:800}}>{game.name} · {formatBytes(game.sizeBytes)}</div><div style={{fontSize:"8.5px",opacity:.52,wordBreak:"break-all"}}>{game.root}</div></div>)}</div><DirectionalNavZone orientation="horizontal" lockCross style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px",marginTop:"14px"}}><DialogButton onClick={()=>closeModal?.()}>{tr("cancel")}</DialogButton><DialogButton onClick={()=>{closeModal?.();void (async()=>{setStorageBusy(true);let freed=0;try{const backup=await backupShortcuts();if(!backup.success)throw new Error(backup.error||"Backup failed");const appIds:number[]=[];for(const game of targets){const removed=await deleteGameDirectory(game.root,game.exe);if(removed.success){freed+=game.sizeBytes;appIds.push(...game.appIds);}}if(appIds.length)await removeShortcutsReliably(appIds);setResult(null);setLastScanLabel(tr("notScannedYet"));setSelectedStorage(new Set());setDelEntries([]);setSelectedDel(new Set());setOpenDelGame(null);const refreshed=await getLibraryStorage(true);setStorageSummary(refreshed);toaster.toast({title:tr("pluginName"),body:`${storageLabel("freed")} ${formatBytes(freed)}`});}catch(e){toaster.toast({title:tr("pluginName"),body:`${storageLabel("failed")}: ${String(e)}`});}finally{setStorageBusy(false);}})();}} style={{color:actionColors.danger,fontWeight:800}}>{storageLabel("deleteSelected")}</DialogButton></DirectionalNavZone></div></ModalRoot>;
    showModal(<Confirm/>);
  };
  const deleteOrphanGroup=(group:{name:string;root:string;items:UnregisteredExecutable[]})=>{
    const first=group.items[0];if(!first)return;
    const Confirm=({closeModal}:{closeModal?:()=>void})=><ModalRoot onCancel={()=>closeModal?.()}><div style={{padding:"10px 16px 18px",minWidth:"520px",maxWidth:"700px"}}><h2>{storageLabel("deleteTitle")}</h2><div style={{fontSize:"13px",fontWeight:850,margin:"8px 0"}}>{group.name}</div><div style={{fontSize:"9px",opacity:.6,wordBreak:"break-all"}}>{group.root}</div><p style={{fontSize:"13px",lineHeight:1.45,color:actionColors.danger,fontWeight:800}}>{storageLabel("deleteWarn")}</p><DirectionalNavZone orientation="horizontal" lockCross style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px",marginTop:"14px"}}><DialogButton onClick={()=>closeModal?.()}>{tr("cancel")}</DialogButton><DialogButton onClick={()=>{closeModal?.();void (async()=>{setBusy(true);try{const removed=await deleteGameDirectory(group.root,first.path);if(!removed.success)throw new Error(removed.error||storageLabel("failed"));setResult(null);setLastScanLabel(tr("notScannedYet"));toaster.toast({title:tr("pluginName"),body:storageLabel("freed")});}catch(e){toaster.toast({title:tr("pluginName"),body:`${storageLabel("failed")}: ${String(e)}`});}finally{setBusy(false);}})();}} style={{color:actionColors.danger,fontWeight:800}}>{storageLabel("deleteOrphan")}</DialogButton></DirectionalNavZone></div></ModalRoot>;
    showModal(<Confirm/>);
  };

  const removeAppIds=async(ids:number[])=>{if(!ids.length)return;setBusy(true);try{const backup=await backupShortcuts();if(!backup.success){toaster.toast({title:tr("pluginName"),body:tr("backupFailed",{error:backup.error??""})});return;}await removeShortcutsReliably(ids);toaster.toast({title:tr("pluginName"),body:tr("removedRefreshing",{count:ids.length})});await refreshAfterRemoval(ids);}catch(e){toaster.toast({title:tr("pluginName"),body:tr("removeFailed",{error:String(e)})});}finally{setBusy(false);}};
  const confirmRemoval=(ids:number[])=>showDeleteConfirm(ids,()=>void removeAppIds(ids));

  const stripQuotes=(value:string)=>value.replace(/^"|"$/g,"");
  const quoteOnce=(value:string)=>`"${stripQuotes(value)}"`;
  const waitForOverview=async(appId:number)=>{for(let i=0;i<50;i++){const o=window.appStore?.GetAppOverviewByAppID(appId);if(o)return true;await sleep(100);}return false;};
  const getAppDetails=(appId:number,timeoutMs=3000)=>new Promise<any|null>((resolve)=>{let done=false;let reg:any;const finish=(v:any)=>{if(done)return;done=true;try{reg?.unregister?.();}catch{}resolve(v);};try{reg=(SteamClient.Apps as any).RegisterForAppDetails(appId,(details:any)=>{if(details)finish(details);});}catch{finish(null);return;}setTimeout(()=>finish(null),timeoutMs);});
  const createShortcut=async(name:string,exePath:string)=>{for(const candidate of [exePath,quoteOnce(exePath)]){try{const id=await SteamClient.Apps.AddShortcut(name,candidate,"","");if(typeof id==="number"&&id!==0)return id;}catch{}}throw new Error(tr("steamRejected",{name}));};
  const addExeShortcut=async(exe:UnregisteredExecutable)=>{const name=exe.name.replace(/\.exe$/i,"")||exe.name;const path=stripQuotes(exe.path);const appId=await createShortcut(name,path);await waitForOverview(appId);const apps=SteamClient.Apps as any;const startDir=path.replace(/\/[^/]+$/,"")||"/";try{apps.SetShortcutName(appId,name);}catch{}try{apps.SetShortcutExe(appId,quoteOnce(path));}catch{}try{apps.SetShortcutStartDir(appId,startDir);}catch{}if(defaultCompatTool){try{apps.SpecifyCompatTool(appId,defaultCompatTool);}catch{}}await sleep(300);const details=await getAppDetails(appId);const readBack=stripQuotes(String(details?.strShortcutExe??""));if(readBack!==path)console.warn(`[LibraryDoctor] ${tr("shortcutUnverified",{name})}: ${readBack}`);return appId;};
  const addSelectedExecutables=async(paths:string[]=Array.from(selectedUnregistered))=>{const pathSet=new Set(paths);const targets=result?.unregisteredExecutables.filter(x=>pathSet.has(x.path))??[];if(!targets.length)return;setBusy(true);let ok=0;const succeeded:string[]=[];const failed:string[]=[];try{for(const exe of targets){try{await addExeShortcut(exe);ok++;succeeded.push(exe.path);sessionAddedPaths.current.add(exe.path);}catch(e){failed.push(`${exe.name}: ${String(e)}`);}}if(succeeded.length&&result){setResult({...result,unregisteredExecutables:result.unregisteredExecutables.filter(x=>!sessionAddedPaths.current.has(x.path))});setSelectedUnregistered(new Set());}toaster.toast({title:tr("pluginName"),body:failed.length?tr("addedWithFailures",{ok,failed:failed.length}):tr("addedSuccess",{ok})});}finally{setBusy(false);}};

  const markSelectedNotGame=async(paths:string[]=Array.from(selectedUnregistered))=>{
    if(!result||!paths.length)return;
    const next=Array.from(new Set([...ignoredExecutables,...paths]));
    setIgnoredExecutables(next);
    await persistSettings(watchedFolders,recursiveFolderScan,next);
    await scan();
  };
  const removeSelectedIgnored=async()=>{
    if(!selectedIgnored.size)return;
    const next=ignoredExecutables.filter(path=>!selectedIgnored.has(path));
    setIgnoredExecutables(next);
    await persistSettings(watchedFolders,recursiveFolderScan,next);
    setSelectedIgnored(new Set());
    await scan();
  };

  const refreshCollections=useCallback(()=>{
    const next=listUserCollections();
    setCollections(next);
    setSelectedCollectionId(cur=>cur&&next.some(c=>c.id===cur)?cur:"");
  },[]);
  useEffect(()=>{refreshCollections();},[refreshCollections,result]);
  const selectedCollection=useMemo(()=>collections.find(c=>c.id===selectedCollectionId)??null,[collections,selectedCollectionId]);

  const refreshDelQueue=useCallback(async(base:ScanResult|null=result)=>{
    if(!base||!selectedCollectionId){setDelEntries([]);setSelectedDel(new Set());setOpenDelGame(null);return;}
    const ids=new Set(readCollectionAppIds(selectedCollectionId));
    if(!ids.size){setDelEntries([]);setSelectedDel(new Set());setOpenDelGame(null);return;}
    const shortcuts=base.items.filter(item=>item.appId!=null&&ids.has(item.appId>>>0)&&!item.utilityShortcut);
    const next:DelEntry[]=[];
    for(const item of shortcuts){
      try{const info=await prepareDeleteCandidate(item.exe,item.startDir||"");next.push({appId:item.appId!,name:item.name,exe:info.exePath||item.exe,startDir:item.startDir,deletePath:info.deletePath,canDelete:info.canDelete,reason:info.reason});}
      catch(e){next.push({appId:item.appId!,name:item.name,exe:item.exe,startDir:item.startDir,deletePath:item.startDir||item.exe.replace(/\\/g,"/").replace(/\/[^/]+$/,"") ,canDelete:false,reason:String(e)});}
    }
    next.sort((a,b)=>a.name.localeCompare(b.name));
    setDelEntries(next);
    setSelectedDel(cur=>new Set([...cur].filter(id=>next.some(x=>x.appId===id))));
    setOpenDelGame(cur=>cur!=null&&next.some(x=>x.appId===cur)?cur:(next[0]?.appId??null));
  },[result,selectedCollectionId]);
  useEffect(()=>{if(result)void refreshDelQueue(result);},[result,selectedCollectionId,refreshDelQueue]);

  const openCollectionPicker=()=>{
    refreshCollections();
    const list=listUserCollections();
    const Picker=({closeModal}:{closeModal?:()=>void})=><ModalRoot onCancel={()=>closeModal?.()}><div style={{padding:"10px 16px 18px",minWidth:"500px",maxWidth:"680px"}}><h2>{tr("chooseDeleteCollection")}</h2><div style={{maxHeight:"48vh",overflowY:"auto",padding:"4px 0"}}>{list.length===0?<div style={{fontSize:"12px",opacity:.7,padding:"10px 4px"}}>{tr("noCollections")}</div>:list.map(c=><ButtonItem key={c.id} onClick={()=>{setCollections(list);setSelectedCollectionId(c.id);setSelectedDel(new Set());setOpenGroups(v=>({...v,del:true}));closeModal?.();}}>{selectedCollectionId===c.id?"✓ ":""}{c.name} ({c.appIds.length})</ButtonItem>)}</div><div style={{marginTop:"12px"}}><DialogButton onClick={()=>closeModal?.()} style={{width:"100%"}}>{tr("cancel")}</DialogButton></div></div></ModalRoot>;
    showModal(<Picker/>);
  };
  const toggleDelGame=(appId:number)=>{
    setOpenDuplicateGames(new Set());
    setOpenUnregisteredGames(new Set());
    setOpenGroups({missing:false,offline:false,invalid:false,duplicates:false,folders:false,unregistered:false,ignored:false,del:true});
    setOpenDelGame(cur=>cur===appId?null:appId);
  };
  const adjustDelEntry=async(entry:DelEntry,direction:"wider"|"narrower")=>{
    try{const info=await adjustDeletePath(entry.deletePath,entry.exe,direction);setDelEntries(cur=>cur.map(x=>x.appId===entry.appId?{...x,deletePath:info.deletePath,canDelete:info.canDelete,reason:info.reason}:x));setSelectedDel(cur=>{const n=new Set(cur);n.delete(entry.appId);return n;});}
    catch(e){toaster.toast({title:tr("pluginName"),body:String(e)});}
  };
  const confirmDeleteDel=()=>{
    const targets=delEntries.filter(x=>selectedDel.has(x.appId)&&x.canDelete);if(!targets.length)return;
    const targetIds=new Set(targets.map(x=>x.appId));
    const otherCount=(result?.items??[]).filter(i=>i.appId!=null&&!targetIds.has(i.appId)&&targets.some(t=>{const p=i.exe.replace(/\\/g,"/");const root=t.deletePath.replace(/\\/g,"/").replace(/\/$/,"");return p===root||p.startsWith(root+"/");})).length;
    const Confirm=({closeModal}:{closeModal?:()=>void})=><ModalRoot onCancel={()=>closeModal?.()}><div style={{padding:"10px 16px 18px",minWidth:"540px",maxWidth:"720px"}}><h2>{tr("destructiveDeleteTitle",{count:targets.length})}</h2><p style={{fontSize:"13px",lineHeight:1.45}}>{tr("destructiveDeleteDesc")}</p><p style={{fontSize:"13px",lineHeight:1.45,color:actionColors.danger,fontWeight:800}}>{tr("destructiveDeleteWarning")}</p>{otherCount>0&&<p style={{fontSize:"12px",color:actionColors.warning,fontWeight:800}}>{tr("otherShortcutWarning",{count:otherCount})}</p>}<div style={{maxHeight:"34vh",overflowY:"auto",padding:"5px 0"}}>{targets.map(x=><div key={x.appId} style={{padding:"6px 8px",margin:"4px 0",borderRadius:"7px",background:"rgba(255,255,255,.035)"}}><div style={{fontSize:"12px",fontWeight:800}}>{x.name}</div><div style={{fontSize:"9px",opacity:.72,wordBreak:"break-all"}}><PathWithBoldFilename path={x.deletePath}/></div></div>)}</div><DirectionalNavZone orientation="horizontal" lockCross style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px",marginTop:"14px"}}><DialogButton onClick={()=>closeModal?.()}>{tr("cancel")}</DialogButton><DialogButton onClick={()=>{closeModal?.();void deleteDelTargets(targets);}} style={{color:actionColors.danger,fontWeight:800}}>{tr("deleteGameFiles")}</DialogButton></DirectionalNavZone></div></ModalRoot>;showModal(<Confirm/>);
  };
  const deleteDelTargets=async(targets:DelEntry[])=>{
    setBusy(true);let ok=0,failed=0;
    try{const backup=await backupShortcuts();if(!backup.success){toaster.toast({title:tr("pluginName"),body:tr("backupFailed",{error:backup.error??""})});return;}
      const removedIds:number[]=[];
      for(const entry of targets){try{const r=await deleteGameDirectory(entry.deletePath,entry.exe);if(!r.success){failed++;continue;}removedIds.push(entry.appId);ok++;}catch{failed++;}}
      if(removedIds.length){
        // Remove collection membership while Steam still has valid app overviews.
        // Otherwise the collection can remain as e.g. 0/3 after the shortcuts
        // themselves are gone.
        await removeAppsFromCollection(selectedCollectionId,removedIds);
        await removeShortcutsReliably(removedIds);
        await refreshAfterRemoval(removedIds);
        refreshCollections();
      }else{
        await scan();
      }
      toaster.toast({title:tr("pluginName"),body:tr("deleteCompleted",{ok,failed})});setSelectedDel(new Set());setOpenDelGame(null);
    }finally{setBusy(false);}
  };

  const scoreMeta=(exe:UnregisteredExecutable)=>{
    const score=Math.max(0,Math.min(100,exe.candidateScore));
    const stars=score>=85?5:score>=70?4:score>=50?3:score>=30?2:1;
    const rating=`${"★".repeat(stars)}${"☆".repeat(5-stars)}`;
    const label=stars>=4?tr("likelyGame"):stars===3?tr("possibleGame"):tr("lowConfidence");
    const color=stars>=4?actionColors.success:stars===3?actionColors.warning:"#b8b8b8";
    return {label,color,rating};
  };

  const unregisteredGameGroups=useMemo(()=>{
    const map=new Map<string,{name:string;root:string;items:UnregisteredExecutable[]}>();
    for(const exe of result?.unregisteredExecutables??[]){
      const root=exe.gameRoot||exe.path.replace(/\/[^/]+$/,"")||exe.rootFolder;
      const name=exe.gameName||root.split("/").filter(Boolean).at(-1)||exe.name.replace(/\.exe$/i,"");
      const key=root.toLowerCase();
      const g=map.get(key)??{name,root,items:[]};
      g.items.push(exe);map.set(key,g);
    }
    return Array.from(map.values()).map(g=>({...g,items:g.items.sort((a,b)=>b.candidateScore-a.candidateScore||a.name.localeCompare(b.name))})).sort((a,b)=>a.root.localeCompare(b.root));
  },[result]);
  const duplicateGameGroups=useMemo(()=>{
    const map=new Map<string,{name:string;root:string;groups:DuplicateGroup[]}>();
    for(const dg of result?.duplicateGroups??[]){
      const root=dg.gameRoot||dg.exe.replace(/\/[^/]+$/,"");
      const name=dg.gameName||root.split("/").filter(Boolean).at(-1)||dg.items[0]?.name||tr("duplicates");
      const key=root.toLowerCase();
      const g=map.get(key)??{name,root,groups:[]};
      g.groups.push(dg);map.set(key,g);
    }
    return Array.from(map.values()).sort((a,b)=>a.root.localeCompare(b.root));
  },[result]);

  const visibleDuplicateSelection=useMemo(()=>{
    // A duplicate selection remains actionable even when its game group is
    // collapsed. Only prune IDs that no longer exist in the current scan.
    const ids=new Set(duplicateGameGroups.flatMap(g=>g.groups.flatMap(dg=>dg.items.map(i=>i.appId).filter((id):id is number=>id!=null))));
    return Array.from(selectedDuplicates).filter(id=>ids.has(id));
  },[duplicateGameGroups,selectedDuplicates]);
  const visibleUnregisteredSelection=useMemo(()=>{
    if(openUnregisteredGames.size===0)return [] as string[];
    const root=Array.from(openUnregisteredGames)[0];
    const game=unregisteredGameGroups.find(g=>g.root===root);
    if(!game)return [] as string[];
    const paths=new Set(game.items.map(i=>i.path));
    return Array.from(selectedUnregistered).filter(path=>paths.has(path));
  },[openUnregisteredGames,unregisteredGameGroups,selectedUnregistered]);

  const openSettingsModal=()=>{
    const SettingsContent=({closeModal}:{closeModal?:()=>void})=>{
      const [localFolders,setLocalFolders]=useState<string[]>(watchedFolders);
      const [localCompat,setLocalCompat]=useState(defaultCompatTool);
      const [saving,setSaving]=useState(false);

      const applySettings=async(nextFolders:string[],nextCompat=localCompat)=>{
        setSaving(true);
        try{
          if(scanInFlight.current){await requestStopScan();await waitForScanIdle();}
          const foldersChanged=JSON.stringify(nextFolders)!==JSON.stringify(localFolders);
          const saved=await saveSettings(nextFolders,true,ignoredExecutables,nextCompat);
          setLocalFolders(saved.watchedFolders??[]);
          setLocalCompat(saved.defaultCompatTool??"");
          setWatchedFolders(saved.watchedFolders??[]);
          setRecursiveFolderScan(true);
          setDefaultCompatTool(saved.defaultCompatTool??"");
          if(foldersChanged){
            setResult(null);
            setLastScanLabel(tr("notScannedYet"));
            setSelected(new Set());
            setSelectedDuplicates(new Set());
            setSelectedUnregistered(new Set());
            setSelectedIgnored(new Set());
            setOpenGroups({missing:false,offline:false,invalid:false,duplicates:false,folders:false,unregistered:false,ignored:false,del:false});
            setOpenDuplicateGames(new Set());
            setOpenUnregisteredGames(new Set());
            setSelectedCollectionId("");
            setDelEntries([]);
            setSelectedDel(new Set());
            setOpenDelGame(null);
          }
          return saved;
        }catch(e){
          toaster.toast({title:tr("pluginName"),body:tr("settingsSaveFailed",{error:String(e)})});
          return null;
        }finally{setSaving(false);}
      };

      const chooseFolder=()=>{
        const initial=localFolders.at(-1)||"/home/deck";
        const Picker=({closeModal:closePicker}:{closeModal?:()=>void})=><ModalRoot onCancel={()=>closePicker?.()}><FolderBrowser initialPath={initial} onClose={()=>closePicker?.()} onSelect={(path)=>{const normalized=path.trim();if(!normalized){closePicker?.();return;}const next=Array.from(new Set([...localFolders,normalized]));closePicker?.();void applySettings(next).then(saved=>{if(saved)toaster.toast({title:tr("pluginName"),body:tr("folderAdded")});});}}/></ModalRoot>;
        showModal(<Picker/>);
      };

      const removeFolderLocal=(folder:string)=>{const next=localFolders.filter(x=>x!==folder);void applySettings(next).then(saved=>{if(saved)toaster.toast({title:tr("pluginName"),body:tr("folderRemoved")});});};
      const confirmClearFolders=()=>{
        const Confirm=({closeModal:closeConfirm}:{closeModal?:()=>void})=><ModalRoot onCancel={()=>closeConfirm?.()}><div style={{padding:"10px 16px 18px",minWidth:"500px",maxWidth:"660px"}}><h2>{tr("clearFoldersTitle")}</h2><p style={{fontSize:"14px",lineHeight:1.45}}>{tr("clearFoldersDesc")}</p><DirectionalNavZone orientation="horizontal" lockCross style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px",marginTop:"16px",width:"100%"}}><DialogButton onClick={()=>closeConfirm?.()} style={{width:"100%",minWidth:0,margin:0}}>{tr("cancel")}</DialogButton><DialogButton onClick={()=>{closeConfirm?.();void applySettings([]).then(saved=>{if(saved)toaster.toast({title:tr("pluginName"),body:tr("foldersCleared")});});}} style={{width:"100%",minWidth:0,margin:0,color:actionColors.danger,fontWeight:700}}>{tr("confirm")}</DialogButton></DirectionalNavZone></div></ModalRoot>;
        showModal(<Confirm/>);
      };
      const chooseCompat=()=>{
        const Compat=({closeModal:closeCompat}:{closeModal?:()=>void})=><ModalRoot onCancel={()=>closeCompat?.()}><div style={{padding:"10px 14px 16px",minWidth:"520px",maxWidth:"680px"}}><h2>{tr("chooseDefaultProton")}</h2><DirectionalNavZone orientation="vertical" style={{maxHeight:"58vh",overflowY:"auto"}}><ButtonItem layout="below" onClick={()=>{closeCompat?.();void applySettings(localFolders,"");}}>{localCompat===""?"✓ ":""}{tr("steamDefault")}</ButtonItem>{compatTools.map(tool=>{const selected=localCompat===tool.strToolName;return <ButtonItem key={tool.strToolName} layout="below" onClick={()=>{closeCompat?.();void applySettings(localFolders,tool.strToolName);}}>{selected?"✓ ":""}{tool.strDisplayName}</ButtonItem>})}{compatTools.length===0&&<div style={{padding:"12px",opacity:.7}}>{tr("compatToolsUnavailable")}</div>}</DirectionalNavZone></div></ModalRoot>;
        showModal(<Compat/>);
      };
      const compatLabel=localCompat?compatTools.find(x=>x.strToolName===localCompat)?.strDisplayName||localCompat:tr("steamDefault");

      return <ModalRoot onCancel={()=>closeModal?.()}><Focusable flow-children="down" style={{padding:"10px 14px 16px",minWidth:"540px",maxWidth:"700px"}}><h2 style={{margin:"0 0 12px"}}>{tr("scanSettings")}</h2><div style={{maxHeight:"64vh",overflowY:"auto",paddingRight:"2px"}}>
        <DirectionalNavZone orientation="vertical" style={{display:"flex",flexDirection:"column",gap:"8px"}}>
          {localFolders.map(folder=><DirectionalNavZone orientation="horizontal" key={folder} style={{display:"flex",alignItems:"center",gap:"8px",padding:"6px 7px",borderRadius:"8px",background:"rgba(255,255,255,.035)",width:"calc(100% - 4px)",margin:"0 2px",boxSizing:"border-box",overflow:"hidden"}}><div style={{flex:"1 1 auto",minWidth:0}}><div style={{fontSize:"13px",fontWeight:750,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{folder.split("/").filter(Boolean).at(-1)||folder}</div><div style={{fontSize:"9px",opacity:.55,wordBreak:"break-all"}}>{folder}</div></div><CompactIconButton label={tr("removeFolder",{folder})} tone="danger" onClick={()=>removeFolderLocal(folder)} disabled={saving||(busy&&!scanning)}><FaTrash/></CompactIconButton></DirectionalNavZone>)}
          <DirectionalNavZone orientation="horizontal" style={{display:"grid",gridTemplateColumns:localFolders.length>0?"1fr 1fr":"1fr",gap:"10px",margin:"4px 0"}}><ActionButton tone="primary" onClick={chooseFolder} disabled={saving||(busy&&!scanning)}><FaFolderOpen style={{marginRight:"7px"}}/>{tr("addScanFolder")}</ActionButton>{localFolders.length>0&&<ActionButton tone="danger" onClick={confirmClearFolders} disabled={saving||(busy&&!scanning)}>{tr("removeAllScanFolders")}</ActionButton>}</DirectionalNavZone>
          <div style={{fontSize:"12px",fontWeight:800,opacity:.82,margin:"8px 2px 0"}}>{tr("protonShortcutSettings")}</div><ActionButton tone="primary" onClick={chooseCompat} disabled={saving||(busy&&!scanning)}><span style={{opacity:.72,marginRight:"5px"}}>{tr("defaultProton")}:</span><strong style={{fontWeight:800}}>{compatLabel}</strong></ActionButton>
        </DirectionalNavZone>
      </div></Focusable></ModalRoot>;
    };
    showModal(<SettingsContent/>);
  };

  const renderShortcutRows=(items:ShortcutItem[])=>items.map(item=>{const checked=item.appId!=null&&selected.has(item.appId);const canSelect=item.status!=="storage_offline"&&item.appId!=null;return <PanelSectionRow key={`${item.appId??item.key}-${item.name}`}><div style={{width:"calc(100% - 4px)",margin:"0 2px",boxSizing:"border-box",overflow:"hidden"}}><ToggleField label={<span style={{fontSize:"11px",fontWeight:700}}>{item.name}</span>} checked={checked} disabled={!canSelect} onChange={()=>toggleItem(item)}/><div style={{fontSize:"9px",lineHeight:1.2,opacity:.52,wordBreak:"break-all",padding:"0 6px 2px"}}><PathWithBoldFilename path={item.exe}/></div></div></PanelSectionRow>;});

  return <>
    <PanelSection title={tr("pluginName")}>
      <PanelSectionRow><div style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:"8px",padding:"0 2px 2px"}}><div style={{fontSize:"11px",opacity:.65}}>v0.19.1 · by nach</div><SettingsIconButton label={tr("settings")} onClick={openSettingsModal} disabled={busy&&!scanning}/></div></PanelSectionRow>
      <PanelSectionRow><div style={{width:"100%"}}>{scanning?<ActionButton tone="danger" onClick={()=>void requestStopScan()} disabled={stoppingScan}>{stoppingScan?tr("stoppingScan"):tr("stopScan")}</ActionButton>:<ActionButton tone="primary" onClick={()=>void scan()} disabled={busy}>{tr("scanNow")}</ActionButton>}{scanning&&scanStatus&&<div style={{margin:"4px 4px 1px",padding:"5px 7px",borderRadius:"6px",background:"rgba(255,255,255,.035)",fontSize:"9.5px",lineHeight:1.35}}><div style={{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",opacity:.7}}>{tr("scanRoot",{path:scanStatus.rootFolder?shortDisplayPath(scanStatus.rootFolder):"-"})}</div><div style={{fontWeight:700,opacity:.92}}>{tr("scanPhase",{phase:scanPhaseLabel(scanStatus.phase)})}{scanStatus.stopRequested?` · ${tr("scanStopRequested")}`:""}</div><div style={{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",opacity:.8}}>{scanStatus.currentFolder?tr("scanCurrent",{path:shortDisplayPath(scanStatus.currentFolder)}):tr("scanDebug",{detail:scanStatus.phaseDetail||"-"})}</div>{scanStatus.currentFolder&&scanStatus.phaseDetail&&<div style={{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",opacity:.58}}>{tr("scanDebug",{detail:scanStatus.phaseDetail})}</div>}<div style={{opacity:.58}}>{tr("scanProgress",{folders:scanStatus.visitedFolders,exes:scanStatus.foundExes})}</div><div style={{opacity:(scanStatus.staleMs??0)>5000?.9:.45,fontWeight:(scanStatus.staleMs??0)>5000?700:400}}>{tr("scanElapsed",{elapsed:Math.floor((scanStatus.elapsedMs??0)/1000),phaseElapsed:Math.floor((scanStatus.phaseElapsedMs??0)/1000),stale:Math.floor((scanStatus.staleMs??0)/1000)})}</div><div style={{opacity:.4,fontSize:"8.5px"}}>ID {scanStatus.scanId}{scanStatus.shortcutFiles!=null?` · VDF ${scanStatus.shortcutFiles}`:""}{scanStatus.shortcutItems!=null?` · shortcuts ${scanStatus.shortcutItems}`:""}{scanStatus.duplicateGroups!=null?` · dup ${scanStatus.duplicateGroups}`:""}{scanStatus.unregisteredFound!=null?` · unreg ${scanStatus.unregisteredFound}`:""}</div><div style={{marginTop:"2px",fontSize:"8.5px",fontWeight:700,opacity:.85}}>UI: {uiScanDebug}</div><div style={{marginTop:"3px",paddingTop:"3px",borderTop:"1px solid rgba(255,255,255,.08)",fontSize:"8.5px",lineHeight:1.3,opacity:.82}}><div style={{fontWeight:800}}>CP {scanStatus.lastCheckpoint?`${scanStatus.lastCheckpoint.seq}: ${scanStatus.lastCheckpoint.label}`:"-"}</div>{scanStatus.lastCheckpoint?.detail&&<div style={{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",opacity:.72}}>{scanStatus.lastCheckpoint.detail}</div>}<div style={{opacity:.58}}>worker {scanStatus.workerThreadAlive?"RUN":"STOP"} · future {scanStatus.futureResolved?"DONE":"WAIT"} · result {scanStatus.resultStored?"STORED":scanStatus.resultReady?"READY":"WAIT"}</div>{(scanStatus.checkpointHistory?.length??0)>0&&<div style={{marginTop:"2px",opacity:.5}}>{scanStatus.checkpointHistory!.slice(-4).map(cp=>`#${cp.seq} ${cp.label} ${Math.floor(cp.atMs/1000)}s`).join(" | ")}</div>}</div></div>}<div style={{fontSize:"10.5px",opacity:.5,textAlign:"right",padding:"1px 4px 0"}}>{tr("lastScan",{time:lastScanLabel})}</div></div></PanelSectionRow>
      {result&&<PanelSectionRow><DirectionalNavZone orientation="vertical" style={{display:"grid",gridTemplateColumns:"1fr",gap:"7px",width:"100%"}}>
        {[
          {label:tr("missing"),value:result.missing,color:actionColors.danger,key:"missing" as const,ref:missingSectionRef,disabled:result.missing===0},
          {label:tr("duplicates"),value:result.duplicateShortcuts,color:actionColors.warning,key:"duplicates" as const,ref:duplicateSectionRef,disabled:result.duplicateGroups.length===0},
          {label:tr("unregistered"),value:result.unregisteredExecutables.length,color:actionColors.success,key:"unregistered" as const,ref:unregisteredSectionRef,disabled:result.unregisteredExecutables.length===0},
          {label:tr("notAGame"),value:result.ignoredExecutables.length,color:"#b8b8b8",key:"ignored" as const,ref:ignoredSectionRef,disabled:result.ignoredExecutables.length===0},
        ].reduce((rows,card,idx)=>{const row=Math.floor(idx/2);(rows[row]??=[]).push(card);return rows;},[] as Array<Array<{label:string;value:number;color:string;key:"missing"|"duplicates"|"unregistered"|"ignored";ref:React.RefObject<HTMLDivElement|null>;disabled:boolean}>>).map((cards,rowIndex)=><DirectionalNavZone key={`dash-row-${rowIndex}`} orientation="horizontal" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px",width:"100%"}}>{cards.map(card=>{
          const active=focusedDashboardCard===card.key&&!card.disabled;
          const cardBody=<div style={{display:"flex",alignItems:"stretch",gap:"7px",minHeight:"30px",color:"#fff"}}>
            {active&&<div aria-hidden="true" style={{width:"3px",borderRadius:"3px",background:String(card.color),boxShadow:`0 0 8px ${String(card.color)}88`,flex:"0 0 3px"}}/>}
            <div style={{minWidth:0,flex:1,display:"flex",flexDirection:"column",justifyContent:"center"}}>
              <div style={{fontSize:"10.5px",lineHeight:"13px",fontWeight:active?750:500,color:card.disabled?"rgba(255,255,255,.40)":active?"#fff":"rgba(255,255,255,.76)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{card.label}</div>
              <div style={{fontSize:"17px",lineHeight:"19px",fontWeight:800,color:card.disabled?"rgba(255,255,255,.42)":active?"#fff":String(card.color),textShadow:active?`0 0 7px ${String(card.color)}66`:"none"}}>{card.value}</div>
            </div>
          </div>;
          if(card.disabled)return <div key={card.key} aria-hidden="true" style={{width:"100%",minWidth:0,minHeight:"40px",boxSizing:"border-box",padding:"4px 8px",borderRadius:"7px",background:"rgba(255,255,255,.025)",opacity:.55,pointerEvents:"none",color:"#fff"}}>{cardBody}</div>;
          return <Focusable key={card.key} flow-children="right" noFocusRing onGamepadFocus={()=>setFocusedDashboardCard(card.key)} onGamepadBlur={()=>setFocusedDashboardCard(cur=>cur===card.key?null:cur)} onFocus={()=>setFocusedDashboardCard(card.key)} onBlur={(e)=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null))setFocusedDashboardCard(cur=>cur===card.key?null:cur);}} style={{width:"100%",minWidth:0}}><DialogButton onClick={()=>jumpToSection(card.key,card.ref)} style={{width:"100%",minWidth:0,minHeight:"40px",margin:0,padding:"4px 8px",display:"block",textAlign:"left",borderRadius:"7px",boxSizing:"border-box",color:"#fff",background:active?`linear-gradient(90deg, ${String(card.color)}34, rgba(255,255,255,.075))`:"rgba(255,255,255,.055)",outline:active?`2px solid ${String(card.color)}`:"2px solid transparent",outlineOffset:"-2px",boxShadow:active?`inset 0 0 0 1px ${String(card.color)}44, 0 0 10px ${String(card.color)}22`:"none",transform:active?"scale(.985)":"none",transition:"background .14s ease, outline-color .14s ease, box-shadow .14s ease, transform .14s ease"}}>{cardBody}</DialogButton></Focusable>;
        })}</DirectionalNavZone>)}
      </DirectionalNavZone></PanelSectionRow>}
    </PanelSection>

    <PanelSection title={storageLabel("title")}>
      <PanelSectionRow><div style={{width:"100%"}}>
        <DirectionalNavZone orientation="horizontal" style={{display:"grid",gridTemplateColumns:storageSummary?"1fr 1fr":"1fr",gap:"8px",width:"100%"}}>
          <ActionButton tone="primary" onClick={()=>void loadStorage(false)} disabled={storageBusy}>{storageBusy?tr("loading"):storageLabel("load")}</ActionButton>
          {storageSummary&&<ActionButton tone="neutral" onClick={()=>void loadStorage(true)} disabled={storageBusy}>{storageLabel("recalc")}</ActionButton>}
        </DirectionalNavZone>
        {storageSummary&&<div style={{marginTop:"7px",padding:"7px 9px",borderRadius:"8px",background:"rgba(255,255,255,.04)",display:"flex",justifyContent:"space-between",gap:"8px",fontSize:"11px"}}><span>{storageSummary.games.length} {storageLabel("games")}</span><strong>{storageLabel("total")} {formatBytes(storageSummary.totalBytes)}</strong></div>}
        {selectedStorageGames.length>0&&<div style={{marginTop:"6px",padding:"7px 9px",borderRadius:"8px",background:"rgba(255,112,112,.08)",border:"1px solid rgba(255,112,112,.18)"}}><div style={{display:"flex",justifyContent:"space-between",gap:"8px",fontSize:"11px",fontWeight:850}}><span>{storageLabel("selected")} {selectedStorageGames.length}</span><span>{formatBytes(selectedStorageBytes)}</span></div><DirectionalNavZone orientation="horizontal" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"7px",marginTop:"7px"}}><ActionButton tone="neutral" onClick={()=>setSelectedStorage(new Set())}>{storageLabel("clear")}</ActionButton><ActionButton tone="danger" onClick={()=>void deleteSelectedStorageGames()} disabled={storageBusy}>{storageLabel("deleteSelected")}</ActionButton></DirectionalNavZone></div>}
      </div></PanelSectionRow>
      {storageSummary&&storageSummary.games.length===0&&<PanelSectionRow><div style={{fontSize:"11px",opacity:.62,padding:"4px"}}>{storageLabel("empty")}</div></PanelSectionRow>}
      {storageSummary&&storageGroups.map(group=>{const open=openStorageGroups.has(group.key);return <div key={group.key} style={{margin:"4px 0 8px",borderRadius:"8px",background:"rgba(255,255,255,.025)",overflow:"hidden"}}><PanelSectionRow><DialogButton onClick={()=>setOpenStorageGroups(cur=>{const n=new Set(cur);n.has(group.key)?n.delete(group.key):n.add(group.key);return n;})} style={{width:"100%",minWidth:0,minHeight:"30px",height:"30px",margin:"1px 0",padding:"0 8px"}}><div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:"8px",width:"100%"}}><span style={{fontSize:"11.5px",fontWeight:850}}>{open?"▾":"▸"} {group.label} · {group.games.length}</span><strong style={{fontSize:"11.5px",color:actionColors.primary}}>{formatBytes(group.bytes)}</strong></div></DialogButton></PanelSectionRow>{open&&group.games.slice(0,storageLimit).map(game=><PanelSectionRow key={game.root}><div style={{width:"calc(100% - 4px)",margin:"0 2px",padding:"6px 7px",boxSizing:"border-box",borderRadius:"8px",background:"rgba(255,255,255,.03)"}}><ToggleField label={<span style={{fontSize:"11.5px",fontWeight:800}}>{game.name} · <span style={{color:actionColors.primary}}>{formatBytes(game.sizeBytes)}</span></span>} checked={selectedStorage.has(game.root)} disabled={!game.canDelete||storageBusy} onChange={()=>setSelectedStorage(cur=>{const n=new Set(cur);n.has(game.root)?n.delete(game.root):n.add(game.root);return n;})}/><div style={{display:"flex",alignItems:"center",gap:"8px",padding:"0 6px 2px"}}><div style={{flex:1,minWidth:0,fontSize:"8.5px",opacity:.48,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{shortDisplayPath(game.root)}{game.cached?` · ${storageLabel("cached")}`:""}</div><CompactIconButton label={storageLabel("delete")} tone="danger" onClick={()=>void deleteStorageGame(game)} disabled={storageBusy||!game.canDelete}><FaTrash/></CompactIconButton></div>{!game.canDelete&&game.reason&&<div style={{fontSize:"8.5px",color:actionColors.warning,marginTop:"3px",padding:"0 6px"}}>{game.reason}</div>}</div></PanelSectionRow>)}</div>})}
      {storageSummary&&storageLimit<storageSummary.games.length&&<PanelSectionRow><ActionButton tone="neutral" onClick={()=>setStorageLimit(v=>v+30)}>{storageLabel("more")} ({Math.min(30,storageSummary.games.length-storageLimit)})</ActionButton></PanelSectionRow>}
    </PanelSection>

    {result&&unregisteredGameGroups.length>0&&<PanelSection title={storageLabel("orphan")}>
      <PanelSectionRow><div style={{fontSize:"10px",lineHeight:1.4,opacity:.62,padding:"3px 5px"}}>{storageLabel("orphanDesc")}</div></PanelSectionRow>
      {unregisteredGameGroups.slice(0,30).map(group=><PanelSectionRow key={`orphan-${group.root}`}><div style={{width:"calc(100% - 4px)",margin:"0 2px",padding:"7px",borderRadius:"8px",background:"rgba(111,208,140,.045)",boxSizing:"border-box"}}><div style={{minWidth:0,marginBottom:"6px"}}><div style={{fontSize:"11.5px",fontWeight:850,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{group.name}</div><div style={{fontSize:"8.5px",opacity:.5,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{shortDisplayPath(group.root)}</div><div style={{fontSize:"9px",opacity:.68,marginTop:"2px"}}>{storageLabel("exeCandidates")} {group.items.length}</div></div><DirectionalNavZone orientation="horizontal" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"7px",width:"100%"}}><ActionButton tone="success" onClick={()=>void addSelectedExecutables(group.items.map(x=>x.path))} disabled={busy}>{storageLabel("addFolderToSteam")} · {group.items.length}</ActionButton><ActionButton tone="danger" onClick={()=>deleteOrphanGroup(group)} disabled={busy}><FaTrash style={{marginRight:"6px"}}/>{storageLabel("deleteOrphan")}</ActionButton></DirectionalNavZone></div></PanelSectionRow>)}
    </PanelSection>

    {result&&result.missing>0&&<div ref={missingSectionRef}><PanelSection title=""><PanelSectionRow><SectionToggle tone="danger" open={openGroups.missing} label={tr("missingExecutable")} count={result.missing} onClick={()=>toggleGroup("missing")}/></PanelSectionRow>{openGroups.missing&&<>{renderShortcutRows(itemsByStatus.missing)}{selected.size>0&&<PanelSectionRow><ActionButton tone="danger" onClick={()=>confirmRemoval([...selected])} disabled={busy}>{tr("removeSelected",{count:selected.size})}</ActionButton></PanelSectionRow>}</>}</PanelSection></div>}

    {result&&result.storageOffline>0&&<PanelSection title=""><PanelSectionRow><SectionToggle tone="primary" open={openGroups.offline} label={tr("storageOffline")} count={result.storageOffline} onClick={()=>toggleGroup("offline")}/></PanelSectionRow>{openGroups.offline&&renderShortcutRows(itemsByStatus.offline)}</PanelSection>}
    {result&&result.invalid>0&&<PanelSection title=""><PanelSectionRow><SectionToggle tone="warning" open={openGroups.invalid} label={tr("invalidShortcuts")} count={result.invalid} onClick={()=>toggleGroup("invalid")}/></PanelSectionRow>{openGroups.invalid&&renderShortcutRows(itemsByStatus.invalid)}</PanelSection>}


    {result&&<div ref={delSectionRef}>
      <PanelSection title="">
        <PanelSectionRow>
          <SectionToggle
            tone="danger"
            open={openGroups.del}
            label={selectedCollection?`${tr("delQueue")} · ${selectedCollection.name}`:tr("delQueue")}
            count={delEntries.length}
            onClick={()=>toggleGroup("del")}
          />
        </PanelSectionRow>
        {openGroups.del&&<>
          <PanelSectionRow>
            <ActionButton tone="primary" onClick={openCollectionPicker} disabled={busy}>
              {selectedCollection?`${tr("deleteCollection")}: ${selectedCollection.name}`:tr("chooseDeleteCollection")}
            </ActionButton>
          </PanelSectionRow>
          {collections.length===0&&<PanelSectionRow><div style={{fontSize:"10px",lineHeight:1.4,opacity:.68,padding:"5px 7px"}}>{tr("noCollections")}</div></PanelSectionRow>}
          {selectedCollection&&delEntries.length===0&&<PanelSectionRow><div style={{fontSize:"10px",lineHeight:1.4,opacity:.68,padding:"5px 7px"}}>{tr("delCollectionMissing")}</div></PanelSectionRow>}
          {delEntries.map(entry=>{
            const gameOpen=openDelGame===entry.appId;
            const checked=selectedDel.has(entry.appId);
            return <div key={`del-${entry.appId}`} style={{marginBottom:"8px",borderRadius:"8px",background:"rgba(255,112,112,.045)",border:"1px solid rgba(255,112,112,.15)",overflow:"hidden"}}>
              <PanelSectionRow>
                <DialogButton onClick={()=>toggleDelGame(entry.appId)} style={{width:"100%",minWidth:0,minHeight:"28px",height:"28px",margin:"1px 0",padding:"0 7px",borderRadius:"6px",borderLeft:`3px solid ${actionColors.danger}`}}>
                  <div style={{width:"100%",display:"flex",alignItems:"center",gap:"7px"}}>
                    <div style={{fontSize:"14px",fontWeight:800,color:actionColors.danger}}>{gameOpen?"▾":"▸"}</div>
                    <div style={{minWidth:0,flex:1,textAlign:"left",fontSize:"12px",fontWeight:800}}>{entry.name}</div>
                  </div>
                </DialogButton>
              </PanelSectionRow>
              {gameOpen&&<>
                <PanelSectionRow>
                  <div style={{width:"calc(100% - 4px)",margin:"0 2px",boxSizing:"border-box",overflow:"hidden"}}>
                    <ToggleField label={<span style={{fontSize:"11px",fontWeight:800}}>{entry.name}</span>} checked={checked} disabled={!entry.canDelete} onChange={()=>setSelectedDel(cur=>{const n=new Set(cur);n.has(entry.appId)?n.delete(entry.appId):n.add(entry.appId);return n;})}/>
                    <div style={{fontSize:"9px",margin:"3px 6px",opacity:.9}}>
                      <div style={{fontSize:"9px",fontWeight:800,color:actionColors.danger,marginBottom:"2px"}}>{tr("deleteTarget")}</div>
                      <PathWithBoldFilename path={entry.deletePath}/>
                    </div>
                    <div style={{fontSize:"9px",margin:"5px 6px",opacity:.56}}>
                      <div style={{fontSize:"9px",fontWeight:700,marginBottom:"2px"}}>{tr("executablePath")}</div>
                      <PathWithBoldFilename path={entry.exe}/>
                    </div>
                    {entry.reason&&<div style={{fontSize:"9px",color:actionColors.warning,padding:"2px 6px 5px"}}>{entry.reason}</div>}
                  </div>
                </PanelSectionRow>
                <PanelSectionRow>
                  <DirectionalNavZone orientation="horizontal" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px",width:"100%"}}>
                    <ActionButton tone="warning" onClick={()=>void adjustDelEntry(entry,"wider")} disabled={busy}>{tr("pathWider")}</ActionButton>
                    <ActionButton tone="primary" onClick={()=>void adjustDelEntry(entry,"narrower")} disabled={busy}>{tr("pathNarrower")}</ActionButton>
                  </DirectionalNavZone>
                </PanelSectionRow>
              </>}
            </div>;
          })}
          {selectedDel.size>0&&<PanelSectionRow><ActionButton tone="danger" onClick={confirmDeleteDel} disabled={busy}>{tr("deleteSelectedGames",{count:selectedDel.size})}</ActionButton></PanelSectionRow>}
        </>}
      </PanelSection>
    </div>}


    {result&&result.duplicateGroups.length>0&&<div ref={duplicateSectionRef}><PanelSection title=""><PanelSectionRow><div style={{fontSize:"13.5px",fontWeight:800,padding:"4px 6px 2px",borderLeft:`3px solid ${actionColors.warning}`}}>{tr("duplicateGroups")} ({duplicateGameGroups.length})</div></PanelSectionRow>{duplicateGameGroups.map((game)=>{const gameOpen=openDuplicateGames.has(game.root);return <div key={`dup-game-${game.root}`} style={{marginBottom:"8px",borderRadius:"8px",background:"rgba(232,189,103,.055)",border:"1px solid rgba(232,189,103,.16)",overflow:"hidden"}}><PanelSectionRow><DialogButton onClick={()=>toggleDuplicateGame(game.root)} style={{width:"100%",minWidth:0,minHeight:"26px",height:"26px",margin:"1px 0",padding:"0 7px",borderRadius:"6px",borderLeft:`3px solid ${actionColors.warning}`}}><div style={{width:"100%",display:"flex",alignItems:"center",gap:"7px"}}><div style={{fontSize:"14px",fontWeight:800,color:actionColors.warning}}>{gameOpen?"▾":"▸"}</div><div style={{minWidth:0,flex:1,textAlign:"left"}}><div style={{fontSize:"12px",fontWeight:800}}>{game.name}</div></div><div style={{fontSize:"11px",fontWeight:700,color:actionColors.warning}}>{game.groups.reduce((n,g)=>n+g.count,0)}</div></div></DialogButton></PanelSectionRow>{gameOpen&&game.groups.map((group,gix)=><div key={`${group.exe}-${gix}`}><PanelSectionRow><div style={{width:"100%",padding:"2px 4px"}}><div style={{fontSize:"9px",lineHeight:1.25,opacity:.66,wordBreak:"break-all"}}><PathWithBoldFilename path={group.exe}/></div></div></PanelSectionRow>{group.items.map(item=>{const p=item.appId!=null?artworkPreviews[item.appId]:undefined;return <div key={`d-${item.appId??item.key}`}>{p?.items?.some(x=>x.dataUrl)&&<PanelSectionRow><div style={{display:"flex",gap:"6px",width:"100%",justifyContent:"flex-start"}}>{p.items.filter(x=>x.dataUrl).slice(0,2).map((img,idx)=><img key={`${item.appId}-${idx}-${img.slot??"art"}`} src={img.dataUrl} style={{width:"82px",height:"54px",objectFit:"cover",borderRadius:"6px",background:"rgba(0,0,0,.2)"}}/>)}</div></PanelSectionRow>}<PanelSectionRow><div style={{width:"calc(100% - 4px)",margin:"0 2px",boxSizing:"border-box",overflow:"hidden",borderRadius:"8px",padding:"5px 7px",background:item.appId!=null&&selectedDuplicates.has(item.appId)?"rgba(232,189,103,.14)":"transparent"}}><ToggleField label={<span style={{fontSize:"11px",fontWeight:700}}>{item.name}</span>} description={<span style={{fontSize:"9px",lineHeight:1.2,opacity:.72}}>{`AppID ${item.appId??"?"} · ${artworkText(item.artwork)}${item.launchOptions?` · ${item.launchOptions}`:""}`}</span>} checked={item.appId!=null&&selectedDuplicates.has(item.appId)} disabled={item.appId==null} onChange={()=>toggleDuplicate(item)}/></div></PanelSectionRow></div>})}</div>)}</div>})}{visibleDuplicateSelection.length>0&&<PanelSectionRow><ActionButton tone="danger" onClick={()=>confirmRemoval(visibleDuplicateSelection)} disabled={busy}>{tr("removeSelectedDuplicates",{count:visibleDuplicateSelection.length})}</ActionButton></PanelSectionRow>}</PanelSection></div>}

    <PanelSection title="">
      {result?.folderScanError&&<PanelSectionRow><Field label={tr("folderScanWarning")} description={result.folderScanError}/></PanelSectionRow>}
      {result&&watchedFolders.length>0&&result.unregisteredExecutables.length>0&&<div ref={unregisteredSectionRef}><PanelSectionRow><div style={{fontSize:"13.5px",fontWeight:800,padding:"4px 6px 2px",borderLeft:`3px solid ${actionColors.success}`}}>{tr("unregisteredExeFiles")} ({result.unregisteredExecutables.length})</div></PanelSectionRow>{unregisteredGameGroups.map(group=>{const gameOpen=openUnregisteredGames.has(group.root);return <div key={`ug-${group.root}`} style={{marginBottom:"8px",borderRadius:"8px",background:"rgba(111,208,140,.045)",border:"1px solid rgba(111,208,140,.14)",overflow:"hidden"}}><PanelSectionRow><DialogButton onClick={()=>toggleUnregisteredGame(group.root)} style={{width:"100%",minWidth:0,minHeight:"26px",height:"26px",margin:"1px 0",padding:"0 7px",borderRadius:"6px",borderLeft:`3px solid ${actionColors.success}`}}><div style={{width:"100%",display:"flex",alignItems:"center",gap:"7px"}}><div style={{fontSize:"14px",fontWeight:800,color:actionColors.success}}>{gameOpen?"▾":"▸"}</div><div style={{minWidth:0,flex:1,textAlign:"left"}}><div style={{fontSize:"12px",fontWeight:800}}>{group.name}</div></div><div style={{fontSize:"11px",fontWeight:700,color:actionColors.success}}>{group.items.length}</div></div></DialogButton></PanelSectionRow>{gameOpen&&group.items.slice(0,MAX_UNREGISTERED_VISIBLE).map(exe=>{const meta=scoreMeta(exe);const checked=selectedUnregistered.has(exe.path);return <PanelSectionRow key={exe.path}><div style={{width:"calc(100% - 4px)",margin:"0 2px",boxSizing:"border-box",overflow:"hidden",borderRadius:"9px",padding:"5px 7px",background:checked?"rgba(111,208,140,.13)":"rgba(255,255,255,.018)"}}><ToggleField label={<span style={{fontSize:"11px",fontWeight:700}}>{exe.name}</span>} description={`${meta.rating} · ${meta.label}`} checked={checked} onChange={()=>toggleUnregistered(exe.path)} /><div style={{fontSize:"9px",lineHeight:1.2,opacity:.52,wordBreak:"break-all",padding:"0 6px 2px"}}><PathWithBoldFilename path={exe.path}/></div></div></PanelSectionRow>})}</div>})}{visibleUnregisteredSelection.length>0&&<><PanelSectionRow><ActionButton tone="success" onClick={()=>void addSelectedExecutables(visibleUnregisteredSelection)} disabled={busy}>{tr("addSelectedToSteam",{count:visibleUnregisteredSelection.length})}</ActionButton></PanelSectionRow><PanelSectionRow><ActionButton tone="neutral" onClick={()=>void markSelectedNotGame(visibleUnregisteredSelection)} disabled={busy}>{tr("markSelectedNotGame",{count:visibleUnregisteredSelection.length})}</ActionButton></PanelSectionRow></>}{result.folderScanTruncated&&<PanelSectionRow><Field label={tr("resultsTruncated")} description={tr("scanLimitReached")}/></PanelSectionRow>}</div>}
      {result&&<div ref={ignoredSectionRef}><PanelSectionRow><SectionToggle tone="neutral" open={openGroups.ignored} label={tr("notAGame")} count={result.ignoredExecutables.length} onClick={()=>toggleGroup("ignored")}/></PanelSectionRow>{openGroups.ignored&&<>{result.ignoredExecutables.map(exe=><PanelSectionRow key={`ignored-${exe.path}`}><div style={{width:"calc(100% - 4px)",margin:"0 2px",boxSizing:"border-box",overflow:"hidden"}}><ToggleField label={<span style={{fontSize:"11px",fontWeight:700}}>{exe.name}</span>} checked={selectedIgnored.has(exe.path)} onChange={()=>toggleIgnored(exe.path)}/><div style={{fontSize:"9px",lineHeight:1.2,opacity:.52,wordBreak:"break-all",padding:"0 6px 2px"}}><PathWithBoldFilename path={exe.path}/></div></div></PanelSectionRow>)}{selectedIgnored.size>0&&<PanelSectionRow><ActionButton tone="neutral" onClick={()=>void removeSelectedIgnored()} disabled={busy}>{tr("removeSelectedIgnored",{count:selectedIgnored.size})}</ActionButton></PanelSectionRow>}</>}</div>}
    </PanelSection>

  </>;
}

export default definePlugin(()=>({
  name:"Library Doctor",
  title:<div className={staticClasses.Title}>{tr("pluginName")}</div>,
  content:<Content/>,
  icon:<FaStethoscope/>,
  alwaysRender:true,
}));