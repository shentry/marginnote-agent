var MNAgentTools = (function () {
  function isNil(value) {
    if (value === null || typeof value === "undefined") return true;
    try {
      return typeof NSNull !== "undefined" && value instanceof NSNull;
    } catch (error) {
      return false;
    }
  }

  function stringValue(value, fallback) {
    if (isNil(value)) return fallback || "";
    try {
      return String(value);
    } catch (error) {
      return fallback || "";
    }
  }

  function numberValue(value) {
    if (typeof value === "number") return value;
    if (isNil(value)) return null;
    try {
      if (typeof value.integerValue === "function") return value.integerValue();
      if (typeof value.doubleValue === "function") return value.doubleValue();
      var converted = Number(value);
      return isNaN(converted) ? null : converted;
    } catch (error) {
      return null;
    }
  }

  function propertyValue(target, name) {
    if (isNil(target)) return null;
    try {
      var value = target[name];
      return typeof value === "function" ? value.call(target) : value;
    } catch (error) {
      return null;
    }
  }

  function arrayValue(value) {
    if (isNil(value)) return [];
    if (Array.isArray(value)) return value;
    var output = [];
    try {
      var count = typeof value.count === "function" ? value.count() : value.length;
      for (var index = 0; index < count; index += 1) {
        if (typeof value.objectAtIndex === "function") output.push(value.objectAtIndex(index));
        else output.push(value[index]);
      }
    } catch (error) {}
    return output;
  }

  function studyController(addon) {
    var app = Application.sharedInstance();
    return app && addon.window ? app.studyController(addon.window) : null;
  }

  function currentTopicId(addon) {
    var study = studyController(addon);
    var notebookController = study && study.notebookController;
    return notebookController ? stringValue(notebookController.notebookId) : "";
  }

  function serializeComment(comment) {
    if (isNil(comment)) return null;
    return {
      type: stringValue(comment.type || comment.commentType),
      text: stringValue(comment.text || comment.noteText || comment.html),
      noteId: stringValue(comment.noteId || comment.noteid),
    };
  }

  function serializeNote(note, includeChildren) {
    if (isNil(note)) return null;
    var comments = arrayValue(note.comments).map(serializeComment).filter(function (item) {
      return item !== null;
    });
    var children = arrayValue(note.childNotes).map(function (child) {
      if (includeChildren) return serializeNote(child, false);
      return {
        noteId: stringValue(child.noteId),
        title: stringValue(child.noteTitle),
      };
    });
    return {
      noteId: stringValue(note.noteId),
      notebookId: stringValue(note.notebookId),
      docMd5: stringValue(note.docMd5),
      title: stringValue(note.noteTitle),
      excerptText: stringValue(note.excerptText),
      notesText: stringValue(note.notesText),
      colorIndex: numberValue(note.colorIndex),
      startPage: numberValue(note.startPage),
      endPage: numberValue(note.endPage),
      comments: comments,
      children: children,
      parentNoteId: !isNil(note.parentNote) ? stringValue(note.parentNote.noteId) : "",
    };
  }

  function serializeNoteSafely(note, includeChildren) {
    if (isNil(note)) return null;
    try {
      return serializeNote(note, includeChildren);
    } catch (error) {
      return {
        noteId: stringValue(note.noteId),
        notebookId: stringValue(note.notebookId),
        docMd5: stringValue(note.docMd5),
        title: stringValue(note.noteTitle),
        excerptText: stringValue(note.excerptText),
        notesText: stringValue(note.notesText),
        comments: [],
        children: [],
        parentNoteId: "",
        truncated: true,
      };
    }
  }

  function normalizeSearchItem(item) {
    if (isNil(item)) return null;
    if (item.note) item = item.note;
    if (item.noteId || item.noteTitle || item.excerptText) return serializeNote(item, false);
    return {
      noteId: stringValue(item.noteId || item.noteid || item.id),
      title: stringValue(item.title || item.noteTitle),
      text: stringValue(item.text || item.excerptText || item.snippet),
      topicId: stringValue(item.topicId || item.topicid),
      docMd5: stringValue(item.docMd5 || item.docmd5),
      page: numberValue(item.page || item.pageNo),
      rowId: numberValue(item.rowid || item.rowId),
    };
  }

  function refresh(topicId) {
    Database.sharedInstance().setNotebookSyncDirty(topicId);
    Application.sharedInstance().refreshAfterDBChanged(topicId);
  }

  function getContext(addon) {
    var study = studyController(addon);
    if (!study) return { available: false, reason: "No active study window" };
    var notebookController = study.notebookController;
    var readerController = study.readerController;
    var documentController = readerController && readerController.currentDocumentController;
    var document = documentController && documentController.document;
    var topicId = notebookController ? stringValue(notebookController.notebookId) : "";
    var notebook = topicId ? Database.sharedInstance().getNotebookById(topicId) : null;
    return {
      available: true,
      notebook: notebook
        ? { topicId: stringValue(notebook.topicId), title: stringValue(notebook.title) }
        : { topicId: topicId, title: "" },
      document: document
        ? {
            docMd5: stringValue(document.docMd5),
            title: stringValue(document.docTitle),
            pageCount: numberValue(propertyValue(document, "pageCount")),
          }
        : null,
      focusNote: notebookController ? serializeNoteSafely(notebookController.focusNote, false) : null,
      selectionText: documentController ? stringValue(documentController.selectionText) : "",
    };
  }

  function takeText(value, state) {
    var text = stringValue(value);
    if (!text || state.remaining <= 0) {
      if (text) state.truncated = true;
      return "";
    }
    if (text.length <= state.remaining) {
      state.remaining -= text.length;
      return text;
    }
    var output = text.slice(0, state.remaining);
    state.remaining = 0;
    state.truncated = true;
    return output;
  }

  function serializeSelectedNote(note, budget) {
    var state = { remaining: budget, truncated: false };
    var comments = [];
    var rawComments = arrayValue(note.comments);
    for (var index = 0; index < rawComments.length && state.remaining > 0; index += 1) {
      var comment = rawComments[index];
      if (isNil(comment)) continue;
      comments.push({
        type: stringValue(comment.type || comment.commentType),
        text: takeText(comment.text || comment.noteText || comment.html, state),
        noteId: stringValue(comment.noteId || comment.noteid),
      });
    }
    if (comments.length < rawComments.length) state.truncated = true;
    return {
      noteId: stringValue(note.noteId),
      notebookId: stringValue(note.notebookId),
      docMd5: stringValue(note.docMd5),
      title: stringValue(note.noteTitle),
      excerptText: takeText(note.excerptText, state),
      notesText: takeText(note.notesText, state),
      startPage: numberValue(note.startPage),
      endPage: numberValue(note.endPage),
      comments: comments,
      truncated: state.truncated,
    };
  }

  function selectedMindMapNotes(addon, args) {
    var study = studyController(addon);
    var notebookController = study && study.notebookController;
    var mindmapView = notebookController && notebookController.mindmapView;
    var selectedViews = arrayValue(mindmapView && mindmapView.selViewLst);
    var limit = Math.max(1, Math.min(Number(args.limit || 20), 50));
    var maxChars = Math.max(1000, Math.min(Number(args.maxChars || 20000), 50000));
    var budget = Math.max(500, Math.floor(maxChars / Math.max(1, Math.min(limit, selectedViews.length))));
    var notes = [];
    var seen = {};
    for (var index = 0; index < selectedViews.length && notes.length < limit; index += 1) {
      var wrapper = selectedViews[index] && selectedViews[index].note;
      var note = wrapper && wrapper.note ? wrapper.note : wrapper;
      if (isNil(note)) continue;
      var noteId = stringValue(note.noteId);
      if (!noteId || seen[noteId]) continue;
      seen[noteId] = true;
      notes.push(serializeSelectedNote(note, budget));
    }
    return {
      selectedCount: selectedViews.length,
      returnedCount: notes.length,
      truncated: notes.length < selectedViews.length || notes.some(function (note) {
        return note.truncated;
      }),
      notes: notes,
    };
  }

  function getSelection(addon, args) {
    var context;
    try {
      context = getContext(addon);
    } catch (error) {
      context = { available: false, document: null, selectionText: "" };
    }
    var selectedNotes = selectedMindMapNotes(addon, args);
    return {
      available: context.available,
      document: context.document,
      selectionText: context.selectionText || "",
      pdfSelection: { text: context.selectionText || "" },
      selectedNotes: selectedNotes,
    };
  }

  function invokePageText(target, methodName, pageIndex) {
    if (isNil(target)) return { supported: false, text: "" };
    try {
      var method = target[methodName];
      if (typeof method !== "function") return { supported: false, text: "" };
      return { supported: true, text: stringValue(method.call(target, pageIndex)) };
    } catch (error) {
      return { supported: false, text: "" };
    }
  }

  function pageText(documentController, document, pageIndex, currentPageIndex) {
    if (pageIndex === currentPageIndex && documentController) {
      try {
        if (typeof documentController.getCurrentPageText === "function") {
          return {
            supported: true,
            text: stringValue(documentController.getCurrentPageText()),
          };
        }
      } catch (error) {}
    }
    var candidates = [
      [document, "textContentsForPageNo2"],
      [document, "textContentsForPageNo"],
      [document, "textForPageNo"],
      [documentController, "textContentsForPageNo2"],
      [documentController, "textContentsForPageNo"],
      [documentController, "textForPageNo"],
    ];
    for (var index = 0; index < candidates.length; index += 1) {
      var result = invokePageText(candidates[index][0], candidates[index][1], pageIndex);
      if (result.supported) return result;
    }
    return { supported: false, text: "" };
  }

  function currentPageIndex(documentController) {
    var names = ["currentPage", "pageNo", "pageIndex"];
    for (var index = 0; index < names.length; index += 1) {
      var value = numberValue(propertyValue(documentController, names[index]));
      if (value !== null && value >= 0) return Math.floor(value);
    }
    return 0;
  }

  function readPdf(addon, args) {
    var study = studyController(addon);
    if (!study) throw new Error("No active study window");
    var readerController = study.readerController;
    var documentController = readerController && readerController.currentDocumentController;
    var document = documentController && documentController.document;
    if (!documentController || !document) throw new Error("No active PDF document");

    var pageCount = numberValue(propertyValue(document, "pageCount"));
    var currentIndex = currentPageIndex(documentController);
    var startPage = Math.floor(Number(args.startPage || currentIndex + 1));
    var endPage = Math.floor(Number(args.endPage || startPage));
    var startChar = Math.max(0, Math.floor(Number(args.startChar || 0)));
    var maxChars = Math.max(1000, Math.min(Number(args.maxChars || 20000), 50000));
    if (startPage < 1 || endPage < startPage) throw new Error("Invalid PDF page range");
    if (pageCount !== null && startPage > pageCount) throw new Error("PDF startPage exceeds pageCount");
    if (pageCount !== null) endPage = Math.min(endPage, pageCount);

    var lastPage = Math.min(endPage, startPage + 19);
    var pages = [];
    var remaining = maxChars;
    var nextCursor = null;
    var supported = false;
    for (var page = startPage; page <= lastPage; page += 1) {
      var extracted = pageText(documentController, document, page - 1, currentIndex);
      supported = supported || extracted.supported;
      var offset = page === startPage ? startChar : 0;
      var available = extracted.text.slice(offset);
      var length = Math.min(available.length, remaining);
      pages.push({
        page: page,
        startChar: offset,
        text: available.slice(0, length),
        complete: length === available.length,
      });
      remaining -= length;
      if (length < available.length) {
        nextCursor = { page: page, charOffset: offset + length };
        break;
      }
      if (remaining <= 0 && page < endPage) {
        nextCursor = { page: page + 1, charOffset: 0 };
        break;
      }
    }
    if (!supported) throw new Error("Current MarginNote document does not expose page text");
    if (!nextCursor && lastPage < endPage) nextCursor = { page: lastPage + 1, charOffset: 0 };

    return {
      available: true,
      document: {
        docMd5: stringValue(document.docMd5),
        title: stringValue(document.docTitle),
        pageCount: pageCount,
        currentPage: currentIndex + 1,
      },
      range: { startPage: startPage, endPage: endPage },
      pages: pages,
      truncated: Boolean(nextCursor),
      nextCursor: nextCursor,
    };
  }

  function listNotebooks(args) {
    var limit = Math.max(1, Math.min(Number(args.limit || 100), 200));
    return arrayValue(Database.sharedInstance().allNotebooks())
      .slice(0, limit)
      .map(function (notebook) {
        return {
          topicId: stringValue(notebook.topicId),
          title: stringValue(notebook.title),
          mainDocMd5: stringValue(notebook.mainDocMd5),
          rootNoteCount: arrayValue(notebook.notes).length,
        };
      });
  }

  function searchNotes(addon, args) {
    var manager = Application.sharedInstance().searchManager;
    if (!manager) throw new Error("SearchManager is unavailable");
    var query = stringValue(args.query).trim();
    if (!query) throw new Error("query is required");
    var scope = stringValue(args.scope, "topic").toLowerCase();
    var limit = Math.max(1, Math.min(Number(args.limit || 30), 100));
    var topicId = stringValue(args.topicId) || currentTopicId(addon) || null;
    var results;
    if (scope === "page") {
      results = manager.searchPage(query, Boolean(args.beginsWith), limit);
    } else {
      if (scope === "all") topicId = null;
      results = manager.searchText(
        query,
        Boolean(args.titleOnly),
        topicId,
        Boolean(args.beginsWith),
        limit,
      );
    }
    return arrayValue(results)
      .slice(0, limit)
      .map(normalizeSearchItem)
      .filter(function (item) {
        return item !== null;
      });
  }

  function getNote(args) {
    var note = Database.sharedInstance().getNoteById(stringValue(args.noteId));
    if (!note) throw new Error("Note not found: " + stringValue(args.noteId));
    return serializeNote(note, Boolean(args.includeChildren));
  }

  function createNote(addon, args) {
    var title = stringValue(args.title).trim();
    if (!title) throw new Error("title is required");
    var topicId = stringValue(args.topicId) || currentTopicId(addon);
    if (!topicId) throw new Error("No target notebook is available");
    var created = null;
    UndoManager.sharedInstance().undoGrouping("Agent 创建笔记", topicId, function () {
      created = Database.sharedInstance().createNoteWithTitleTopicid(title, topicId);
      if (args.parentNoteId) {
        var parent = Database.sharedInstance().getNoteById(stringValue(args.parentNoteId));
        if (!parent) throw new Error("Parent note not found: " + stringValue(args.parentNoteId));
        parent.addChild(created);
      }
      if (args.comment) {
        if (args.commentFormat === "markdown") created.appendMarkdownComment(stringValue(args.comment));
        else created.appendTextComment(stringValue(args.comment));
      }
    });
    refresh(topicId);
    return serializeNote(created, false);
  }

  function updateNote(args) {
    var note = Database.sharedInstance().getNoteById(stringValue(args.noteId));
    if (!note) throw new Error("Note not found: " + stringValue(args.noteId));
    var hasChange =
      typeof args.title !== "undefined" ||
      typeof args.excerptText !== "undefined" ||
      typeof args.colorIndex !== "undefined";
    if (!hasChange) throw new Error("No fields to update");
    var topicId = stringValue(note.notebookId);
    UndoManager.sharedInstance().undoGrouping("Agent 修改笔记", topicId, function () {
      if (typeof args.title !== "undefined") note.noteTitle = stringValue(args.title);
      if (typeof args.excerptText !== "undefined") note.excerptText = stringValue(args.excerptText);
      if (typeof args.colorIndex !== "undefined") note.colorIndex = Number(args.colorIndex);
    });
    refresh(topicId);
    return serializeNote(note, false);
  }

  function appendComment(args) {
    var note = Database.sharedInstance().getNoteById(stringValue(args.noteId));
    if (!note) throw new Error("Note not found: " + stringValue(args.noteId));
    var text = stringValue(args.text);
    if (!text) throw new Error("text is required");
    var topicId = stringValue(note.notebookId);
    UndoManager.sharedInstance().undoGrouping("Agent 追加评论", topicId, function () {
      if (args.format === "markdown") note.appendMarkdownComment(text);
      else note.appendTextComment(text);
    });
    refresh(topicId);
    return serializeNote(note, false);
  }

  function focusNote(addon, args) {
    var study = studyController(addon);
    if (!study) throw new Error("No active study window");
    var noteId = stringValue(args.noteId);
    if (!Database.sharedInstance().getNoteById(noteId)) throw new Error("Note not found: " + noteId);
    if (args.target === "document") study.focusNoteInDocumentById(noteId);
    else study.focusNoteInMindMapById(noteId);
    return { focused: true, noteId: noteId, target: args.target || "mindmap" };
  }

  function execute(addon, tool, args) {
    args = args || {};
    switch (tool) {
      case "get_context":
        return getContext(addon);
      case "get_selection":
        return getSelection(addon, args);
      case "read_pdf":
        return readPdf(addon, args);
      case "list_notebooks":
        return listNotebooks(args);
      case "search_notes":
        return searchNotes(addon, args);
      case "get_note":
        return getNote(args);
      case "create_note":
        return createNote(addon, args);
      case "update_note":
        return updateNote(args);
      case "append_comment":
        return appendComment(args);
      case "focus_note":
        return focusNote(addon, args);
      default:
        throw new Error("Unknown MarginNote tool: " + tool);
    }
  }

  return { execute: execute };
})();
