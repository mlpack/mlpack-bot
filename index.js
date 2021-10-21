const staleConfig = {
    daysUntilStale: 30,
    daysUntilClose: 7,
    exemptLabels: [ 's: keep open' ],
    exemptProjects: false,
    exemptMilestones: true,
    exemptAssignees: false,
    staleLabel: 's: stale',
    markComment: 'This issue has been automatically marked as stale because it has not had any recent activity.  It will be closed in 7 days if no further activity occurs.  Thank you for your contributions! :+1:',
    limitPerRun: 30,
    approvalComment: "Second approval provided automatically after 24 hours. :+1:"
};

process.env.IGNORED_ACCOUNTS = "Anupam-tripathi,Anupam-tripathi-zz"
const createScheduler = require('probot-scheduler')
const Stale = require('./lib/stale')
const { exec } = require("child_process")

const newPRWelcomeComment = "Thanks for opening your first pull request in this repository!  Someone will review it when they have a chance.  In the mean time, please be sure that you've handled the following things, to make the review process quicker and easier:\n\n - All code should follow the [style guide](https://github.com/mlpack/mlpack/wiki/DesignGuidelines#style-guidelines)\n - Documentation added for any new functionality\n - Tests added for any new functionality\n - Tests that are added follow the [testing guide](https://github.com/mlpack/mlpack/wiki/Testing-Guidelines)\n - Headers and license information added to the top of any new code files\n - HISTORY.md updated if the changes are big or user-facing\n - All CI checks should be passing\n\nThank you again for your contributions!  :+1:"

const stickerComment = "Hello there!  Thanks for your contribution.  I see that this is your first contribution to mlpack.  If you'd like to add your name to the list of contributors in `COPYRIGHT.txt` and you haven't already, please feel free to push a change to this PR---or, if it gets merged before you can, feel free to open another PR.\n\nIn addition, if you'd like some stickers to put on your laptop, I'd be happy to help get them in the mail for you.  Just send an email with your physical mailing address to stickers@mlpack.org, and then one of the mlpack maintainers will put some stickers in an envelope for you.  It may take a few weeks to get them, depending on your location. :+1:"

async function issueOpened(context)
{
  // If an issue was opened, we want to try and tag it with relevant labels.
  const { payload, github } = context

  // Does the issue have any labels?
  if (!payload.issue || payload.issue.labels.length === 0)
  {
    /**
     * Fetch the issue again to double-check that it has no labels.
     * Sometimes, when an issue is opened with labels, the initial
     * webhook event contains no labels.
     * https://github.com/eslint/eslint-github-bot/issues/38
     */
    const issue = await github.issues.get({
        owner: context.issue().owner,
        repo: context.issue().repo,
        issue_number: context.issue().number }).then((res) => res.data)

    if (issue.labels.length === 0)
    {
      await github.issues.addLabels({
          owner: context.issue().owner,
          repo: context.issue().repo,
          issue_number: context.issue().number,
          labels: ['s: unlabeled', 's: unanswered'] })
    }
  }
}

async function prOpened(context)
{
  // If a PR was opened, we want to try and tag it with relevant labels.
  const { payload, github } = context

  if (!payload.pr || payload.pr.labels.length === 0)
  {
    /**
     * Fetch the issue again to double-check that it has no labels.
     * Sometimes, when an issue is opened with labels, the initial
     * webhook event contains no labels.
     * https://github.com/eslint/eslint-github-bot/issues/38
     */
    const pr = await github.issues.get(context.issue()).then((res) => res.data)

    if (pr.labels.length === 0)
    {
      await github.issues.addLabels(context.issue({ labels:
          ['s: unlabeled', 's: unanswered', 's: needs review'] }))
    }

    // Now check to see if we need to add a welcome comment for this.
    const response = await context.github.issues.listForRepo(context.repo({
        state: 'all',
        creator: context.payload.pull_request.user.login
    }));

    const countPR = response.data.filter(data => data.pull_request);
    if (countPR.length === 1)
    {
      try
      {
        context.github.issues.createComment(context.issue(
            { body: newPRWelcomeComment }));
      }
      catch (error)
      {
        if (error.code !== 404)
        {
          throw error;
        }
      }
    }
  }
}

async function prReviewed(context)
{
  // Check if it has approvals.
  let reviews = await context.github.pulls.listReviews({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      pull_number: context.payload.pull_request.number });
  let page = 1;
  let approvals = [];

  do
  {
    approvals = approvals.concat(reviews.data.map(review => [review.state, review.author_association, review.user.login]).filter(
        data => data[0].toLowerCase() === 'approved' &&
                (data[1].toLowerCase() === 'member' ||
                  (data[1].toLowerCase() === 'none' && data[2].toLowerCase() === 'mlpack-bot[bot]'))))

    page++;
    reviews = await context.github.pulls.listReviews({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      pull_number: context.payload.pull_request.number,
      page: page });
  } while (reviews.data !== undefined && reviews.data.length != 0)

  // Filter non-unique approvals.
  const approvalMap = new Map();
  const uniqueApprovals = [];
  for (const item of approvals)
  {
    if (!approvalMap.has(item[2]))
    {
      approvalMap.set(item[2], true);
      uniqueApprovals.push(item);
    }
  }

  // Only post after the second approval.
  if (uniqueApprovals.length === 2)
  {
    // The PR is approved.  Now, has this user ever had a PR merged before?
    const creator = context.payload.pull_request.user.login;
    const { owner, repo } = context.repo();
    const res = await context.github.search.issuesAndPullRequests({
        q: `is:pr is:merged author:${creator} org:${owner}` })
    const mergedPRs = res.data.items.filter(
        pr => pr.number !== context.payload.pull_request.number).length

    // But what if we have already sent a sticker notification?
    // Check if it has comments from mlpack-bot that are the exact sticker
    // comment..
    let comments = await context.github.issues.listComments({
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        issue_number: context.payload.pull_request.number,
        per_page: 100 });
    let page = 1;
    let commented = false;

    do
    {
      let c_list = comments.data.map(comment => [comment.author_association, comment.user.login, comment.body]).filter(
          data => (data[0].toLowerCase() === 'none' && data[1].toLowerCase() === 'mlpack-bot[bot]' && data[2] === stickerComment))
      if (c_list.length > 0)
      {
        commented = true;
        break;
      }

      page++;
      comments = await context.github.issues.listComments({
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        issue_number: context.payload.pull_request.number,
        page: page,
        per_page: 100 });
    } while (comments.data !== undefined && comments.data.length != 0)

    if (mergedPRs === 0 && !commented)
    {
      try
      {
        context.github.issues.createComment(context.issue({
            body: stickerComment }));
      }
      catch (err)
      {
        if (err.code !== 404)
        {
          throw err
        }
      }
    }

    // Try to remove any needs-review label, if it exists.
    labels = await context.github.issues.listLabelsOnIssue({
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        issue_number: context.payload.pull_request.number})
    let needs_review_count = labels.data.map(n => [n.name]).filter(n => (n[0] == 's: needs review'))
    if (needs_review_count.length > 0)
    {
      await context.github.issues.removeLabel({
          owner: context.payload.repository.owner.login,
          repo: context.payload.repository.name,
          issue_number: context.payload.pull_request.number,
          name: 's: needs review'})
    }
  }
}

async function prMerged(context)
{
  if (context.payload.pull_request.merged === true)
  {
    console.log("PR was merged!\n")
    console.log("context:\n")
    console.log(context);

    /**
     * Get the labels for the PR.
     */
    labels = await context.github.issues.listLabelsOnIssue({
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        issue_number: context.payload.pull_request.number });

    console.log("got labels:\n");
    console.log(labels);

    let release_count = labels.data.map(n => [n.name]).filter(n => (n[0] == 't: release'));
    if (release_count.length > 0)
    {
      // Awesome, it was a release.  Get the relevant ref.
      console.log("releaseTestOutput:\n")
      ref = await context.github.git.getRef({
          owner: context.payload.repository.owner.login,
          repo: context.payload.repository.name,
          ref: "heads/master" });
      console.log("got ref:\n");
      console.log(ref);

      // Get the pull request name so we can parse it.
      pr_data = await context.github.pulls.get({
          owner: context.payload.repository.owner.login,
          repo: context.payload.repository.name,
          pull_number: context.payload.number
      })
      console.log("pr data:\n")
      console.log(pr_data)

      var titleRegex = /^Release version ([0-9]*).([0-9]*).([0-9]*)(: )?(.*)$/
      var results = titleRegex.exec(pr_data.data.title)

      major_version = results[1]
      minor_version = results[2]
      patch_version = results[3]
      release_name = results[5]

      // Compute the tag name for the new release.
      release_tag_name = major_version.toString() + '.' +
          minor_version.toString() + '.' + patch_version.toString();

      // Compute the string that we will use for the description of the new
      // version in the release.
      var descrRegex = /### Changelog\r?\n/m
      var results = descrRegex.exec(pr_data.data.body)
      changelog_text = pr_data.data.body.substring(results.index + 14, pr_data.data.body.length)

      // Two commits back should be the actual release (since there is a merge
      // commit).
      head_commit = await context.github.git.getCommit({
          owner: context.payload.repository.owner.login,
          repo: context.payload.repository.name,
          commit_sha: ref.data.object.sha });
      console.log("head commit:\n");
      console.log(head_commit);

      parent_commit = await context.github.git.getCommit({
          owner: context.payload.repository.owner.login,
          repo: context.payload.repository.name,
          commit_sha: head_commit.data.parents[0].sha }); // Umm, I hope.

      console.log("parent commit:\n");
      console.log(parent_commit);

      // Now create the tag...
      result = await context.github.git.createTag({
          owner: context.payload.repository.owner.login,
          repo: context.payload.repository.name,
          tag: release_tag_name,
          message: "Release test.",
          object: parent_commit.data.sha,
          type: "commit"
      })

      console.log("result:\n");
      console.log(result);

      // Now finally create the reference to the tag in the repository.
      result = await context.github.git.createRef({
          owner: context.payload.repository.owner.login,
          repo: context.payload.repository.name,
          sha: parent_commit.data.sha,
          ref: ("refs/tags/" + release_tag_name)
      })

      const monthNames = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July",
          "Aug.", "Sep.", "Oct.", "Nov.", "Dec."]
      const d = new Date();
      bodyString = "Released " + monthNames[d.getMonth()] + " " +
          d.getDate().toString() + ", " + d.getFullYear() + ".\n\n" +
          changelog_text;

      console.log("now create release\n")
      if (release_name != "")
      {
        result = await context.github.repos.createRelease({
            owner: context.payload.repository.owner.login,
            repo: context.payload.repository.name,
            tag_name: release_tag_name,
            name: "ensmallen " + release_tag_name + ": " + release_name,
            body: bodyString,
            draft: true
        })
        console.log("result:\n")
        console.log(result)
      }
      else
      {
        result = await context.github.repos.createRelease({
            owner: context.payload.repository.owner.login,
            repo: context.payload.repository.name,
            tag_name: release_tag_name,
            name: "mlpack " + release_tag_name,
            body: bodyString,
            draft: true
        })
        console.log("result:\n")
        console.log(result)
      }

      // Lastly, we need to fire off the website update script.
      // Note that /home/ryan/src/ensmallen-mlpack-bot/ should exist and be a
      // clone of ensmallen.  All this has to happen in a screen session so that
      // ssh keys are set up that can push to the ensmallen.org repo directly.
      if (release_name != "")
      {
        // It's an ensmallen release.
        exec('screen -S master -p ensmallen.org -X stuff "cd /home/ryan/src/ensmallen-mlpack-bot/\n"',
             function(error, stdout, stderr) {
               if (error) { console.log(error) }
               if (stderr) { console.log(stderr) }
        })
        exec('screen -S master -p ensmallen.org -X stuff "git pull\n"',
             function(error, stdout, stderr) {
               if (error) { console.log(error) }
               if (stderr) { console.log(stderr) }
        })
        exec('screen -S master -p ensmallen.org -X stuff "scripts/update-website-after-release.sh ' +
            major_version.toString() + ' ' + minor_version.toString() + ' ' +
            patch_version.toString() + '\n"',
             function(error, stdout, stderr) {
               if (error) { console.log(error) }
               if (stderr) { console.log(stderr) }
               console.log(stdout)
        })
      }
      else
      {
        // It's an mlpack release.
        exec('screen -S master -p mlpack.org -X stuff "cd /home/ryan/src/mlpack-mlpack-bot/\n"',
            function(error, stdout, stderr) {
              if (error) { console.log(error) }
              if (stderr) { console.log(stderr) }
        })
        exec('screen -S master -p mlpack.org -X stuff "git pull\n"',
            function(error, stdout, stderr) {
              if (error) { console.log(error) }
              if (stderr) { console.log(stderr) }
        })
        exec('screen -S master -p mlpack.org -X stuff "/home/ryan/bin/update-mlpack-website-after-release.sh ' +
            major_version.toString() + ' ' + minor_version.toString() + ' ' +
            patch_version.toString() + '\n"',
            function(error, stdout, stderr) {
              if (error) { console.log(error) }
              if (stderr) { console.log(stderr) }
              console.log(stdout)
        })
      }
    }
  }
}

module.exports = app => {
  // Visits all repositories to mark and sweep stale issues.
  const scheduler = createScheduler(app)

  // Unmark stale issues if a suer comments.
  const events = [ 'issue_comment', 'issues', 'pull_request',
      'pull_request_review', 'pull_request_review_comment' ]

  app.on(events, unmark)
  app.on('schedule.repository', markAndSweep)
  app.on('schedule.repository', autoApprove)
  app.on('issues.opened', issueOpened)
  app.on('pull_request.opened', prOpened)
  app.on('pull_request.reopened', prOpened)
  app.on('pull_request_review.submitted', prReviewed)
  app.on('pull_request_review.edited', prReviewed)
  app.on('pull_request.closed', prMerged)

  async function forRepository(context)
  {
    config = Object.assign(staleConfig, context.repo({ logger: app.log }))

    return new Stale(context.github, staleConfig)
  }

  async function unmark(context)
  {
    if (!context.isBot)
    {
      const stale = await forRepository(context)
      let issue = context.payload.issue || context.payload.pull_request
      const type = context.payload.issue ? 'issues' : 'pulls'

      // Some payloads don't include labels.
      if (!issue.labels)
      {
        try
        {
          issue = (await context.github.issues.get(context.issue())).data
        }
        catch (error)
        {
          context.log('Issue not found!')
        }
      }

      const staleLabelAdded = context.payload.action === 'labeled' &&
          context.payload.label.name === stale.config.staleLabel

      if (stale.hasStaleLabel(type, issue) && issue.state !== 'closed' && !staleLabelAdded)
      {
        stale.unmark(type, issue)
      }
    }
  }

  async function markAndSweep(context)
  {
    const stale = await forRepository(context)
    await stale.markAndSweep('pulls')
    await stale.markAndSweep('issues')
  }

  async function autoApprove(context)
  {
    const stale = await forRepository(context)
    await stale.autoApprove()
  }
}
