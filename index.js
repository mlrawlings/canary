const git = require("simple-git");

/**
 * This is the main entrypoint to your Probot app
 * @param {import("probot").Application} app
 */
module.exports = app => {
  // https://developer.github.com/v3/activity/events/types/#checkrunevent
  // https://developer.github.com/v3/activity/events/types/#checksuiteevent
  app.on(["check_suite.requested", "check_run.rerequested"], async context => {
    // TODO: add short circuit to prevent cascading checks across dependency network

    const startTime = new Date();
    const versions = await getCanaryVersions(context);
    const dependents = await findDependents(context);
    const { head_branch: headBranch, head_sha: commitSha } = context.payload.check_suite;

    const results = await Promise.all(dependents.map(async (dependentRepo) => {
      // TODO: get the most recent passing commit on the default_branch?
      if (await isPassing(dependentRepo)) {
        const cloneDirectory = await cloneDependent(dependentRepo);
        const branchName = await createBranch(cloneDirectory);
        const updatedSha = await updateBranch(cloneDirectory, versions);
        await pushBranch(cloneDirectory, branchName);
        const results = await getCommitStatus(dependentRepo, updatedSha);
        await deleteBranch(cloneDirectory, branchName);
        return { repo:dependentRepo, results };
      }
    }));
    
    // https://developer.github.com/v3/checks/
    // return context.github.checks.create(context.repo({
    //   name: "Canary in the CI",
    //   head_branch: headBranch,
    //   head_sha: commitSha,
    //   status: "completed",
    //   started_at: startTime,
    //   conclusion: "success",
    //   completed_at: new Date(),
    //   output: {
    //     title: "Probot check!",
    //     summary: "The check has passed!"
    //   }
    // }))
  });

  // https://developer.github.com/v3/activity/events/types/#installationrepositoriesevent
  app.on("installation.created", async context => {
    const installation = context.payload.installation

    await eachRepository(app, installation, async repository => {
      await setRepositoryDependencies(repository);
    });
  });

  // https://developer.github.com/v3/activity/events/types/#installationrepositoriesevent
  app.on("installation_repositories.added", async context => {
    await setRepositoryDependencies(context.payload.installation);
  });

  // https://developer.github.com/v3/activity/events/types/#pushevent
  app.on("push", async context => {
    if (isPushToMaster(context.payload)) {
      await updateRepositoryDependencies(context.payload.repository);
    }
  });

  // https://developer.github.com/v3/activity/events/types/#statusevent
  app.on("status", async context => {
    if (context.payload.state !== "pending") {
      const key = createCommitKey(context.repo(), context.payload.sha);
      const promise = statusPromises.get(key);
      promise.resolve(context.payload);
    }
  });
}

//////////

const statusPromises = new Map();
const npmDependents = new Map();
const npmDependencies = new Map();

//////////

/**
 * Find other repositories in the network that depend on the repo represented by context
 * @param {*} context 
 */
const findDependents = async (context) => {
  const { owner, repo } = context.repo();
  return npmDependents.get(`${owner}/${repo}`);
}

/**
 * Returns true if all the checks for the HEAD of the default branch are passing
 * @param {*} dependentRepo
 */
const isPassing = async (dependentRepo) => {
  
}

const deleteRepositoryDependencies = (repository) => {
  const repoKey = repository.full_name; // `${repository.owner}/${repository.name}`
  if (npmDependencies.has(repoKey)) {
    const dependencies = npmDependencies.get(repoKey);
    dependencies.forEach(dependency => {
      if (npmDependents.has(dependency)) {
        const dependents = npmDependents.get(dependency);
        dependents.delete(dependency);
      }
    });
    npmDependencies.delete(repoKey);
  }
}

const updateRepositoryDependencies = async (repository, github) => {
  deleteRepositoryDependencies(repository);
  await initRepositoryDependencies(repository, github);
}

const initRepositoryDependencies = async (repository, github) => {
  const repoKey = repository.full_name; // `${repository.owner}/${repository.name}`
  if (!npmDependencies.has(repoKey)) {
    const packages = await findPackageJsons(repository, github);
    const dependencies = new Set();
    npmDependencies.set(repoKey, dependencies);
    
    packages.map(package => {
      Object.keys(package.dependencies).forEach(dependency => {
        let dependents;
        if (!npmDependents.has(dependency)) {
          dependents = npmDependents.get(dependency);
        } else {
          dependents = new Set();
          npmDependents.set(dependency, dependents);
        }
        dependencies.add(dependency);
        dependents.add(repository);
      });
    });
  }
}

const isPushToMaster = (pushEventPayload) => {
  const defaultBranch = pushEventPayload.repository.defaultBranch;
  return `refs/heads/${defaultBranch}` === pushEventPayload.ref;
}

const findPackageJsons = async (repository, github) => {

}

/**
 * Shallowly clones a dependent to a temporary directory, checks out the default branch, and returns the temporary directory
 * @param {*} dependentRepo
 */
const cloneDependent = async (dependentRepo) => {
  const cloneDirectory = await createTempDirectory();
  const remoteUrl = getRemoteUrl(dependentRepo);
  await git(cloneDirectory).clone(remoteUrl, cloneDirectory, { "--depth": 1 });
  return cloneDirectory;
}

const createBranch = async (cloneDirectory) => {
  const branchName = createBranchName();
  await git(cloneDirectory).checkoutBranch(branchName, "master");
  return branchName;
}

const updateBranch = async (cloneDirectory, versions) => {

}

const pushBranch = async (cloneDirectory, branchName) => {
  return git(cloneDirectory).push("origin", branchName);
}

const getCommitStatus = async (dependentRepo, dependentSha) => {
  const key = createCommitKey(dependentRepo, dependentSha);
  const promise = createResolvablePromise();
  const timeout = createTimeoutPromise(60*60*1000);
  statusPromises.set(key, promise);
  return Promise.race([
    promise,
    timeout.then(() => statusPromises.delete(key))
  ]);
}

const deleteBranch = async (cloneDirectory, branchName) => {
  return git(cloneDirectory).deleteLocalBranch(branchName).push("origin", branchName, { "--delete":null });
}

//////////

const getRemoteUrl = (repo) => {
  return `git@github.com:${repo.owner}/${repo.repo}.git`;
}

const createCommitKey = (repo, commitSha) => {
  return `${repo.owner}/${repo.repo}#${commitSha}`;
}

const createBranchName = () => {
  return `citci:${Math.ceil(Math.random() * 1000000000)}`;
}

const createResolvablePromise = () => {
  let resolve;
  const promise = new Promise(
    _resolve => (resolve = _resolve)
  );
  promise.resolve = resolve;
  return promise;
};

const createTimeoutPromise = (timeout) => {
  return new Promise(
    resolve => setTimeout(resolve, timeout)
  );
};

const eachRepository = async (app, installation, callback) => {
  app.log.trace({ installation }, 'Fetching repositories for installation');
  const github = await app.auth(installation.id)

  const repositories = await github.paginate(
    github.apps.listRepos.endpoint.merge({ per_page: 100 }),
    response => response.data.repositories
  );

  const filteredRepositories = options.filter
    ? repositories.filter(repo => options.filter(installation, repo))
    : repositories;

  return Promise.all(filteredRepositories.map(async repository => callback(repository, github)));
}