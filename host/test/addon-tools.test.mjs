import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

async function loadTools({ document, documentController, selectedViews, focusNote = null }) {
  const notebookController = {
    notebookId: "topic-1",
    focusNote,
    mindmapView: { selViewLst: selectedViews },
  };
  const study = {
    notebookController,
    readerController: { currentDocumentController: documentController },
  };
  documentController.document = document;
  class NSNull {}
  const context = vm.createContext({
    NSNull,
    Application: {
      sharedInstance: () => ({ studyController: () => study }),
    },
    Database: {
      sharedInstance: () => ({
        getNotebookById: () => ({ topicId: "topic-1", title: "算法" }),
      }),
    },
  });
  vm.runInContext(await readFile(new URL("../../addon/tools.js", import.meta.url), "utf8"), context);
  return context.MNAgentTools;
}

test("addon reads PDF selection and selected mind-map notes", async () => {
  const note = {
    noteId: "note-1",
    notebookId: "topic-1",
    docMd5: "doc-1",
    noteTitle: "选中的卡片",
    excerptText: "摘录",
    notesText: "笔记正文",
    comments: [{ type: "text", text: "评论" }],
  };
  const tools = await loadTools({
    document: { docMd5: "doc-1", docTitle: "测试 PDF", pageCount: 3 },
    documentController: { currentPage: 1, selectionText: "PDF 选区" },
    selectedViews: [{ note: { note } }],
  });

  const result = tools.execute({ window: {} }, "get_selection", {});
  assert.equal(result.pdfSelection.text, "PDF 选区");
  assert.equal(result.selectedNotes.selectedCount, 1);
  assert.equal(result.selectedNotes.notes[0].title, "选中的卡片");
  assert.equal(result.selectedNotes.notes[0].comments[0].text, "评论");
});

test("addon reads current PDF pages and returns a continuation cursor", async () => {
  const pageText = "x".repeat(1500);
  const tools = await loadTools({
    document: {
      docMd5: "doc-1",
      docTitle: "测试 PDF",
      pageCount: 3,
      textContentsForPageNo2: (page) => (page === 0 ? pageText : `page-${page + 1}`),
    },
    documentController: { currentPage: 1, selectionText: "", getCurrentPageText: () => "page-2" },
    selectedViews: [],
  });

  const result = tools.execute({ window: {} }, "read_pdf", {
    startPage: 1,
    endPage: 3,
    maxChars: 1000,
  });
  assert.equal(result.pages[0].page, 1);
  assert.equal(result.pages[0].text.length, 1000);
  assert.equal(result.nextCursor.page, 1);
  assert.equal(result.nextCursor.charOffset, 1000);
  assert.equal(result.truncated, true);
});
