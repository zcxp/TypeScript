/// <reference types="node" />

import http = require("http");
import fs = require("fs");
import path = require("path");
import url = require("url");
import child_process = require("child_process");
import os = require("os");

/// Command line processing ///

if (process.argv[2] == "--help") {
    console.log("Runs a node server on port 8888, looking for tests folder in the current directory\n");
    console.log("Syntax: node nodeServer.js [typescriptEnlistmentDirectory] [tests] [--browser] [--verbose]\n");
    console.log("Examples: \n\tnode nodeServer.js .");
    console.log("\tnode nodeServer.js 3000 D:/src/typescript/public --verbose IE");
}

function switchToForwardSlashes(path: string) {
    return path.replace(/\\/g, "/").replace(/\/\//g, "/");
}

const port = 8888; // harness.ts and webTestResults.html depend on this exact port number.

let browser: string;
if (process.argv[2]) {
    browser = process.argv[2];
    if (browser !== "chrome" && browser !== "IE") {
        console.log(`Invalid command line arguments. Got ${browser} but expected chrome, IE or nothing.`);
    }
}

const grep = process.argv[3];

let verbose = false;
if (process.argv[4] == "--verbose") {
    verbose = true;
}
else if (process.argv[4] && process.argv[4] !== "--verbose") {
    console.log(`Invalid command line arguments. Got ${process.argv[4]} but expected --verbose or nothing.`);
}

/// Utils ///
function log(msg: string) {
    if (verbose) {
        console.log(msg);
    }
}

// Copied from the compiler sources
function dir(dirPath: string, spec?: string, options?: any) {
    options = options || <{ recursive?: boolean; }>{};
    return filesInFolder(dirPath);

    function filesInFolder(folder: string): string[] {
        folder = switchToForwardSlashes(folder);
        let paths: string[] = [];
        // Everything after the current directory is relative
        const baseDirectoryLength = process.cwd().length + 1;

        try {
            const files = fs.readdirSync(folder);
            for (let i = 0; i < files.length; i++) {
                const stat = fs.statSync(path.join(folder, files[i]));
                if (options.recursive && stat.isDirectory()) {
                    paths = paths.concat(filesInFolder(path.join(folder, files[i])));
                }
                else if (stat.isFile() && (!spec || files[i].match(spec))) {
                    const relativePath = folder.substring(baseDirectoryLength);
                    paths.push(path.join(relativePath, files[i]));
                }
            }
        }
        catch (err) {
            // Skip folders that are inaccessible
        }
        return paths;
    }
}

// fs.rmdirSync won't delete directories with files in it
function deleteFolderRecursive(dirPath: string) {
    if (fs.existsSync(dirPath)) {
        fs.readdirSync(dirPath).forEach((file, index) => {
            const curPath = path.join(path, file);
            if (fs.statSync(curPath).isDirectory()) { // recurse
                deleteFolderRecursive(curPath);
            }
            else { // delete file
                fs.unlinkSync(curPath);
            }
        });
        fs.rmdirSync(dirPath);
    }
};

function writeFile(path: string, data: any, opts: { recursive: boolean }) {
    try {
        fs.writeFileSync(path, data);
    }
    catch (e) {
        // assume file was written to a directory that exists, if not, start recursively creating them as necessary
        const parts = switchToForwardSlashes(path).split("/");
        for (let i = 0; i < parts.length; i++) {
            const subDir = parts.slice(0, i).join("/");
            if (!fs.existsSync(subDir)) {
                fs.mkdir(subDir);
            }
        }
        fs.writeFileSync(path, data);
    }
}

/// Request Handling ///

function handleResolutionRequest(filePath: string, res: http.ServerResponse) {
    let resolvedPath = path.resolve(filePath, "");
    resolvedPath = resolvedPath.substring(resolvedPath.indexOf("tests"));
    resolvedPath = switchToForwardSlashes(resolvedPath);
    send("success", res, resolvedPath);
    return;
}

function send(result: "fail", res: http.ServerResponse, contents: string, contentType?: string): void;
function send(result: "success", res: http.ServerResponse, contents: string, contentType?: string): void;
function send(result: "unknown", res: http.ServerResponse, contents: string, contentType?: string): void;
function send(result: string, res: http.ServerResponse, contents: string, contentType?: string): void
function send(result: string, res: http.ServerResponse, contents: string, contentType = "binary"): void {
    const responseCode = result === "success" ? 200 : result === "fail" ? 500 : result === "unknown" ? 404 : parseInt(result);
    res.writeHead(responseCode, { "Content-Type": contentType });
    res.end(contents);
    return;
}

// Reads the data from a post request and passes it to the given callback
function processPost(req: http.ServerRequest, res: http.ServerResponse, callback: (data: string) => any): void {
    let queryData = "";
    if (typeof callback !== "function") return;

    if (req.method == "POST") {
        req.on("data", (data: string) => {
            queryData += data;
            if (queryData.length > 1e8) {
                queryData = "";
                send("413", res, undefined);
                console.log("ERROR: destroying connection");
                req.connection.destroy();
            }
        });

        req.on("end", () => {
            // res.post = url.parse(req.url).query;
            callback(queryData);
        });

    }
    else {
        send("405", res, undefined);
    }
}

enum RequestType {
    GetFile,
    GetDir,
    ResolveFile,
    WriteFile,
    DeleteFile,
    WriteDir,
    DeleteDir,
    AppendFile,
    Unknown
}

function getRequestOperation(req: http.ServerRequest, filename: string) {
    if (req.method === "GET" && req.url.indexOf("?") === -1) {
        if (req.url.indexOf(".") !== -1) return RequestType.GetFile;
        else return RequestType.GetDir;
    }
    else {
        const queryData: any = url.parse(req.url, /*parseQueryString*/ true).query;
        if (req.method === "GET" && queryData.resolve !== undefined) return RequestType.ResolveFile;
        // mocha uses ?grep=<regexp> query string as equivalent to the --grep command line option used to filter tests
        if (req.method === "GET" && queryData.grep !== undefined) return RequestType.GetFile;
        if (req.method === "POST" && queryData.action) {
            const path = req.url.substr(0, req.url.lastIndexOf("?"));
            const isFile = path.substring(path.lastIndexOf("/")).indexOf(".") !== -1;
            switch (queryData.action.toUpperCase()) {
                case "WRITE":
                    return isFile ? RequestType.WriteFile : RequestType.WriteDir;
                case "DELETE":
                    return isFile ? RequestType.DeleteFile : RequestType.DeleteDir;
                case "APPEND":
                    return isFile ? RequestType.AppendFile : RequestType.Unknown;
            }
        }
        return RequestType.Unknown;
    }
}

function handleRequestOperation(req: http.ServerRequest, res: http.ServerResponse, operation: RequestType, reqPath: string) {
    switch (operation) {
        case RequestType.GetDir:
            const filesInFolder = dir(reqPath, "", { recursive: true });
            send("success", res, filesInFolder.join(","));
            break;
        case RequestType.GetFile:
            fs.readFile(reqPath, (err, file) => {
                const contentType = contentTypeForExtension(path.extname(reqPath));
                if (err) {
                    send("fail", res, err.message, contentType);
                }
                else {
                    send("success", res, <any>file, contentType);
                }
            });
            break;
        case RequestType.ResolveFile:
            const resolveRequest = req.url.match(/(.*)\?resolve/);
            handleResolutionRequest(resolveRequest[1], res);
            break;
        case RequestType.WriteFile:
            processPost(req, res, (data) => {
                writeFile(reqPath, data, { recursive: true });
            });
            send("success", res, undefined);
            break;
        case RequestType.WriteDir:
            fs.mkdirSync(reqPath);
            send("success", res, undefined);
            break;
        case RequestType.DeleteFile:
            if (fs.existsSync(reqPath)) {
                fs.unlinkSync(reqPath);
            }
            send("success", res, undefined);
            break;
        case RequestType.DeleteDir:
            if (fs.existsSync(reqPath)) {
                fs.rmdirSync(reqPath);
            }
            send("success", res, undefined);
            break;
        case RequestType.AppendFile:
            processPost(req, res, (data) => {
                fs.appendFileSync(reqPath, data);
            });
            send("success", res, undefined);
            break;
        case RequestType.Unknown:
        default:
            send("unknown", res, undefined);
            break;
    }

    function contentTypeForExtension(ext: string) {
        switch (ext) {
            case ".js": return "text/javascript";
            case ".css": return "text/css";
            case ".html": return "text/html";
            default: return "binary";
        }
    }
}

console.log(`Static file server running at\n  => http://localhost:${port}/\nCTRL + C to shutdown`);

http.createServer((req: http.ServerRequest, res: http.ServerResponse) => {
    log(`${req.method} ${req.url}`);
    const uri = url.parse(req.url).pathname;
    const reqPath = path.join(process.cwd(), uri);
    const operation = getRequestOperation(req, reqPath);
    handleRequestOperation(req, res, operation, reqPath);
}).listen(port);

let browserPath: string;
if (browser === "chrome") {
    let defaultChromePath = "";
    switch (os.platform()) {
        case "win32":
        case "win64":
            defaultChromePath = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
            break;
        case "darwin":
            defaultChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
            break;
        case "linux":
            defaultChromePath = "/opt/google/chrome/chrome";
            break;
        default:
            console.log(`default Chrome location is unknown for platform '${os.platform()}'`);
            break;
    }
    if (fs.existsSync(defaultChromePath)) {
        browserPath = defaultChromePath;
    }
    else {
        browserPath = browser;
    }
}
else {
    const defaultIEPath = "C:/Program Files/Internet Explorer/iexplore.exe";
    if (fs.existsSync(defaultIEPath)) {
        browserPath = defaultIEPath;
    }
    else {
        browserPath = browser;
    }
}

console.log(`Using browser: ${browserPath}`);

const queryString = grep ? `?grep=${grep}` : "";
child_process.spawn(browserPath, [`http://localhost:${port}/tests/webTestResults.html${queryString}`], {
    stdio: "inherit"
});
