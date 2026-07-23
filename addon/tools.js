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
      parentNoteId: note.parentNote ? stringValue(note.parentNote.noteId) : "",
    };
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
            pageCount: numberValue(document.pageCount),
          }
        : null,
      focusNote: notebookController ? serializeNote(notebookController.focusNote, false) : null,
      selectionText: documentController ? stringValue(documentController.selectionText) : "",
    };
  }

  function getSelection(addon) {
    var context = getContext(addon);
    return {
      available: context.available,
      document: context.document,
      selectionText: context.selectionText || "",
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
        return getSelection(addon);
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
