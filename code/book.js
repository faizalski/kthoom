/**
 * book.js
 *
 * Licensed under the MIT License
 *
 * Copyright(c) 2018 Google Inc.
 */
import { Page, createPageFromFile } from './page.js';

// TODO(epub): Create a BookBinder class that is responsible for the unarchiver, listens to its
//     events, and emits its own types of events when pages are added.

const LoadState = {
  NOT_LOADED: 0,
  LOADING: 1,
  LOADED: 2,
  LOADING_ERROR: 3,
};

// TODO(epub): This state is only used locally in the context of unarchiving the file.
//     Move this into the BookBinder module.
const UnarchiveState = {
  NOT_UNARCHIVED: 0,
  READY_FOR_UNARCHIVING: 1,
  UNARCHIVING: 2,
  UNARCHIVED: 3,
  UNARCHIVING_ERROR: 4,
};

export class BookEvent {
  constructor(book) { this.book = book; }
}

// The book knows its load / unarchive percentages.
export class BookProgressEvent extends BookEvent {
  constructor(book) { super(book); }
}

// TODO(epub): Do not export this.  Move it into the BookBinder for internal use or remove.
export class ReadyToUnarchiveEvent extends BookEvent {
  constructor(book) { super(book); }
}

// TODO(epub): This should be renamed to PageAddedEvent.
export class UnarchivePageExtractedEvent extends BookEvent {
  constructor(book, page, pageNum) {
    super(book);
    this.page = page;
    this.pageNum = pageNum;
  }
}

export class UnarchiveCompleteEvent extends BookEvent {
  constructor(book) { super(book); }
}

/**
 * A Book has a name, a set of pages, and a loading and unarchiving state.  It is responsible for
 * unarchiving itself and emitting events to any subscribers as interesting things happen to it.
 */
export class Book {
  /**
   * @param {string} name
   * @param {string} uri
   */
  constructor(name, uri = undefined) {
    /**
     * The name of the book (shown in the Reading Stack).
     * @type {String}
     */
    this.name_ = name;

    /**
     * The optional URI of the book (not set for a File).
     * @type {String}
     */
    this.uri_ = uri;

    this.loadState_ = LoadState.NOT_LOADED;
    this.unarchiveState_ = UnarchiveState.NOT_UNARCHIVED;

    this.expectedSizeInBytes_ = 0;

    /**
     * How much of the book has been loaded.  A number between 0 and 1.0.
     * @private {number}
     */
    this.loadingPercentage_ = 0.0;

    /**
     * How much of the book has been unarchived.  A number between 0 and 1.0.
     * @private {number}
     */
    this.unarchivingPercentage_ = 0.0;

    /**
     * The total known number of pages.
     * @private {number}
     */
    this.totalPages_ = 0;

    this.unarchiver_ = null;

    /** @private {Array<Page>} */
    this.pages_ = [];

    // As each file becomes available from the Unarchiver, we kick off an async operation
    // to construct a Page object.  After all pages are retrieved, we sort and then add
    // to the pages_ array.
    /** @private {Promise<Page>} */
    this.pagePromises_ = [];

    /**
     * A map of objects that are listening to events from this Book.  The key is the object instance
     * and the value is the bound callback function.
     * @private {Object<Object, Function>}
     */
    this.subscribers_ = {};
  }

  getName() { return this.name_; }
  getLoadingPercentage() { return this.loadingPercentage_; }
  getUnarchivingPercentage() { return this.unarchivingPercentage_; }
  getNumberOfPages() { return this.totalPages_; }
  getNumberOfPagesReady() { return this.pages_.length; }

  /**
   * @param {number} i A number from 0 to (num_pages - 1).
   * @return {Page}
   */
  getPage(i) {
    // TODO: This is a bug in the unarchivers.  The only time totalPages_ is set is
    // upon getting a UnarchiveEvent.Type.PROGRESS which has the total number of files.
    // In some books, we get an EXTRACT event before we get the first PROGRESS event.
    const numPages = this.totalPages_ || this.pages_.length;
    if (i < 0 || i >= numPages) {
      return null;
    }
    return this.pages_[i];
  }

  /** @return {boolean} */
  isReadyToUnarchive() { return this.unarchiveState_ === UnarchiveState.READY_FOR_UNARCHIVING; }

  /**
   * Starts an XHR and progressively loads in the book.
   * @param {Number} expectedSize If -1, the total field from the XHR Progress event is used.
   * @param {Object<string, string>} headerMap A map of request header keys and values.
   * @return {Promise<Book>} A Promise that returns this book when done.
   */
  loadFromXhr(expectedSize = -1, headerMap = {}) {
    if (this.loadState_ !== LoadState.NOT_LOADED) {
      throw 'Cannot try to load via XHR when the Book is already loading or loaded';
    }
    if (!this.uri_) {
      throw 'URI for book was not set from loadFromXhr()';
    }

    return new Promise((resolve, reject) => {
      this.expectedSizeInBytes_ = expectedSize;

      const xhr = new XMLHttpRequest();
      xhr.open('GET', this.uri_, true);
      for (const headerKey in headerMap) {
        xhr.setRequestHeader(headerKey, headerMap[headerKey]);
      }

      xhr.responseType = 'arraybuffer';
      xhr.onprogress = (evt) => {
        if (expectedSize == -1 && evt.total) {
          this.expectedSizeInBytes_ = expectedSize = evt.total;
        }
        let pct = evt.loaded / expectedSize;
        if (pct) {
          this.loadingPercentage_ = pct;
          this.notify_(new BookProgressEvent(this));
        }
      }
      xhr.onload = (evt) => {
        const arrayBuffer = evt.target.response;
        this.setArrayBuffer_(arrayBuffer, 0, expectedSize);
        resolve(this);
      };
      xhr.onerror = (err) => {
        reject(err);
      }
      xhr.send(null);
    });
  }

  /**
   * Starts a fetch and progressively loads in the book.
   * @param {Number} expectedSize If -1, the total field from the XHR Progress event is used.
   * @param {Object<string, string>} headerMap A map of request header keys and values.
   * @return {Promise<Book>} A Promise that returns this book when done.
   */
  loadFromFetch(init, expectedSize) {
    if (this.loadState_ !== LoadState.NOT_LOADED) {
      throw 'Cannot try to load via XHR when the Book is already loading or loaded';
    }
    if (!this.uri_) {
      throw 'URI for book was not set in loadFromFetch()';
    }

    return fetch(this.uri_, init).then(response => {
      const reader = response.body.getReader();
      let bytesRead = 0;
      const readAndProcessNextChunk = () => {
        reader.read().then(({done, value}) => {
          if (!done) {
            // value is a chunk of the file as a Uint8Array.
            bytesRead += value.length;
            let pct = bytesRead / expectedSize;

            if (!this.unarchiver_) {
              // At this point, the Unarchiver should be created and we should have
              // enough to get started on the unarchiving process.
              this.setArrayBuffer_(value.buffer, pct, expectedSize);
            } else {
              // Update the unarchiver with more bytes.
              this.loadingPercentage_ = pct;
              this.unarchiver_.update(value.buffer);
            }

            this.notify_(new BookProgressEvent(this));

            readAndProcessNextChunk();
          }
        });
      };
      readAndProcessNextChunk();
      return this;
    });
  }

  /**
   * @param {File} file
   * @return {Promise<Book>} A Promise that returns this book when done.
   */
  loadFromFile(file) {
    if (this.loadState_ !== LoadState.NOT_LOADED) {
      throw 'Cannot try to load via File when the Book is already loading or loaded';
    }
    if (this.uri_) {
      throw 'URI for book was set in loadFromFile()';
    }

    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const ab = fr.result;
        try {
          this.setArrayBuffer_(ab, 1.0, ab.byteLength);
        } catch (err) {
          const errMessage = err + ': ' + file.name;
          console.error(errMessage);
          reject(errMessage);
        }
        resolve(this);
      };
      fr.readAsArrayBuffer(file);
    });
  }

  /**
   * @param {ArrayBuffer} ab
   * @return {Promise<Book>} A Promise that returns this book when done.
   */
  loadFromArrayBuffer(ab) {
    if (this.loadState_ !== LoadState.NOT_LOADED) {
      throw 'Cannot try to load via File when the Book is already loading or loaded';
    }
    if (this.uri_) {
      throw 'URI for book was set in loadFromArrayBuffer()';
    }

    this.setArrayBuffer_(ab, 1.0, ab.byteLength);
  }

  /**
   * Resets the book and creates the Unarchiver.
   * @param {ArrayBuffer} ab
   * @param {number} pctLoaded
   * @param {number} expectedSizeInBytes
   * @private
   */
  setArrayBuffer_(ab, pctLoaded, expectedSizeInBytes) {
    // Reset the book completely.
    this.unarchiver_ = null;
    this.expectedSizeInBytes_ = expectedSizeInBytes;
    this.totalPages_ = 0;
    this.pages_ = [];
    this.pagePromises_ = [];
    this.loadState_ = pctLoaded < 1.0 ? LoadState.LOADING : LoadState.LOADED;
    this.loadingPercentage_ = pctLoaded;
    this.unarchiveState_ = UnarchiveState.READY_FOR_UNARCHIVING;
    this.unarchivingPercentage_ = 0.0;

    this.unarchiver_ = bitjs.archive.GetUnarchiver(ab, 'code/bitjs/');

    if (!this.unarchiver_) {
      throw 'Could not determine the unarchiver to use for the file'
    }

    this.notify_(new ReadyToUnarchiveEvent(this));
  }

  // TODO(epub): Rename this to create() or something.  Unarchiving is handled by the BookBinder.
  unarchive() {
    const start = (new Date).getTime();

    // TODO(epub):  This is the process of binding for comic book files, each extracted file
    //     is a page.  Move this into code into a ComicBookBinder class.
    if (this.unarchiver_) {
      this.unarchiveState_ = UnarchiveState.UNARCHIVING;

      this.unarchiver_.addEventListener(bitjs.archive.UnarchiveEvent.Type.PROGRESS, (e) => {
          this.totalPages_ = e.totalFilesInArchive;
          this.unarchivingPercentage_ = e.totalCompressedBytesRead / this.expectedSizeInBytes_;
          this.notify_(new BookProgressEvent(this));
      });
      this.unarchiver_.addEventListener(bitjs.archive.UnarchiveEvent.Type.INFO, (e) => console.log(e.msg));
      this.unarchiver_.addEventListener(bitjs.archive.UnarchiveEvent.Type.EXTRACT, (e) => {
          // Convert each unarchived file into a Page.
          // TODO: Error if not present?
          if (e.unarchivedFile) {
            // TODO: Error if we have more pages than totalPages_.
            this.pagePromises_.push(createPageFromFile(e.unarchivedFile));

            // Do not send extracted events yet, because the pages may not be in the correct order.
            //this.notify_(new UnarchivePageExtractedEvent(this, newPage, this.pages_.length));
          }
      });
      this.unarchiver_.addEventListener(bitjs.archive.UnarchiveEvent.Type.FINISH, (e) => {
        this.unarchiveState_ = UnarchiveState.UNARCHIVED;
        this.unarchivingPercentage_ = 1.0;
        const diff = ((new Date).getTime() - start)/1000;
        console.log(`Book = '${this.name_}'`);
        console.log(`  number of pages = ${this.getNumberOfPages()}`);
        console.log(`  using ${this.unarchiver_.getScriptFileName()}`);
        console.log(`  unarchiving done in ${diff}s`);

        const pages = [];
        let foundError = false;
        let pagePromiseChain = Promise.resolve(true);
        for (let pageNum = 0; pageNum < this.pagePromises_.length; ++pageNum) {
          pagePromiseChain = pagePromiseChain.then(() => {
            return this.pagePromises_[pageNum]
                .then(page => pages.push(page))
                .catch(e => foundError = true)
                .finally(() => true);
          });
        }

        pagePromiseChain.then(() => {
          // Update the total pages for only those pages that were valid.
          this.totalPages_ = pages.length;

          if (foundError) {
            alert('Some pages had errors. See the console for more info.')
          }

          // Sort the book's pages based on filename.
          // TODO(epub): This will not work with epub files, since pages are not associated with
          //     files.
          this.pages_ = pages.slice(0).sort((a,b) => {
            return a.filename.toLowerCase() > b.filename.toLowerCase() ? 1 : -1;
          });

          // Issuing an extract event for each page in its proper order.
          for (let i = 0; i < this.pages_.length; ++i) {
            this.notify_(new UnarchivePageExtractedEvent(this, this.pages_[i], i + 1));
          }

          // Emit a complete event.
          this.notify_(new UnarchiveCompleteEvent(this));

          // Stop the Unarchiver (which will kill the worker) and then delete the unarchiver
          // which should free up some memory, including the unarchived array buffer.
          this.unarchiver_.stop();
          this.unarchiver_ = null;
        });
      });
      this.unarchiver_.start();
    } else {
      alert('Error:  Could not determine the type of comic book archive file.  ' +
        'kthoom only supports cbz, cbr and cbt files.');
    }
  }

  /**
   * Subscribes the object to listen to events from this Book.
   * @param {Object} source
   * @param {Function} The function that should be called with the event from this Book.  At call
   *     time, the function is bound to the source.
   */
  subscribe(source, callback) {
    this.subscribers_[source] = callback;
  }

  /**
   * Unsubscribes the object from listening to events from this Book.
   * @param {Object} source
   */
  unsubscribe(source) {
    if (this.subscribers_[source]) {
      delete this.subscribers_[source];
    }
  }

  /** @private */
  notify_(evt) {
    for (let source in this.subscribers_) {
      const boundCallbackFn = this.subscribers_[source].bind(source);
      boundCallbackFn(evt, this);
    }
  }
}
