const core = require("@actions/core");
const fs = require("fs/promises");
const fsOld = require("fs");
const path = require("path");
const webdav = require("webdav");

async function getLocalFiles(root) {
  async function* getFilesInternal(dir, pathPrefix) {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const filePath = path.join(dir, dirent.name);
      const relativePath = path.join(pathPrefix, dirent.name);

      if (dirent.isDirectory()) {
        yield* getFilesInternal(filePath, relativePath);
      } else {
        const stats = await fs.stat(filePath);
        yield {
          filePath: filePath,
          relativePath: relativePath,
          modifiedDate: stats.mtime,
        };
      }
    }
  }

  const result = [];
  for await (const file of getFilesInternal(root, "")) {
    result.push(file);
  }
  return result;
}

async function getServerFiles(client, root) {
  const contents = await client.getDirectoryContents(root, {
    deep: true,
  });

  return contents
    .filter(function (item) {
      return item.type == "file";
    })
    .map(function (file) {
      return {
        filePath: file.filename,
        relativePath: file.filename.split(path.sep).splice(2).join(path.sep),
        modifiedDate: Date.parse(file.lastmod),
      };
    });
}

async function deploy(params) {
  const server = params.server;
  const username = params.username;
  const password = params.password;
  const localDir = params.localDir;
  const serverDir = params.serverDir;

  const client = webdav.createClient(server, {
    username: username,
    password: password,
  });

  if ((await client.exists(serverDir)) === false) {
    await client.createDirectory(serverDir);
  }

  const localFiles = await getLocalFiles(localDir);

  const serverFiles = await getServerFiles(client, serverDir);

  const localFilesToAdd = localFiles.filter(
    (localFile) =>
      !serverFiles.some(
        (serverFile) => serverFile.relativePath == localFile.relativePath
      )
  );

  const serverFilesToDelete = serverFiles.filter(
    (serverFile) =>
      !localFiles.some(
        (localFile) => serverFile.relativePath == localFile.relativePath
      )
  );

  const localFilesToUpdate = localFiles.filter((localFile) =>
    serverFiles.some(
      (serverFile) =>
        serverFile.relativePath == localFile.relativePath &&
        localFile.modifiedDate > serverFile.modifiedDate
    )
  );

  const serverCountAfterDeploy =
    serverFiles.length + localFilesToAdd.length - serverFilesToDelete.length;

  if (serverCountAfterDeploy != localFiles.length) {
    throw Error(
      "Error calculating diff: the server file count after deployment would not match the local file count."
    );
  }

  console.log(`Writing ${localFilesToAdd.length} new files...`);
  for await (const localFile of localFilesToAdd) {
    console.log(localFile.relativePath);

    const serverFilePath = path.join(serverDir, localFile.relativePath);

    const pathComponents = serverFilePath.split(path.sep);
    pathComponents.pop();

    var soFar = "";
    for (const component of pathComponents) {
      soFar = path.join(soFar, component);
      if ((await client.exists(soFar)) === false) {
        await client.createDirectory(soFar);
      }
    }

    const readStream = fsOld.createReadStream(localFile.filePath);
    await client.putFileContents(serverFilePath, readStream, {
      overwrite: false,
    });
  }

  console.log("");

  console.log(`Updating ${localFilesToUpdate.length} existing files...`);
  for await (const localFile of localFilesToUpdate) {
    console.log(localFile.relativePath);
    const readStream = fsOld.createReadStream(localFile.filePath);

    const serverFilePath = path.join(serverDir, localFile.relativePath);
    await client.putFileContents(serverFilePath, readStream, {
      overwrite: true,
    });
  }

  console.log("");

  console.log(`Deleting ${serverFilesToDelete.length} files...`);
  for await (const serverFile of serverFilesToDelete) {
    console.log(serverFile.relativePath);
    await client.deleteFile(serverFile.filePath);
  }
}

async function deployAction() {
  try {
    await deploy({
      server: core.getInput("server"),
      username: core.getInput("username"),
      password: core.getInput("password"),
      localDir: core.getInput("local-dir"),
      serverDir: core.getInput("server-dir"),
    });
  } catch (error) {
    core.setFailed(error.message);
  }
}

deployAction();
