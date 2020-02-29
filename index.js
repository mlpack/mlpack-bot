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

process.env.IGNORED_ACCOUNTS = "Anupam-tripathi"
const createScheduler = require('probot-scheduler')
const Stale = require('./lib/stale')

const newPRWelcomeComment = "Thanks for opening your first pull request in this repository!  Someone will review it when they have a chance.  In the mean time, please be sure that you've handled the following things, to make the review process quicker and easier:\n\n - All code should follow the [style guide](https://github.com/mlpack/mlpack/wiki/DesignGuidelines#style-guidelines)\n - Documentation added for any new functionality\n - Tests added for any new functionality\n - Tests that are added follow the [testing guide](https://github.com/mlpack/mlpack/wiki/Testing-Guidelines)\n - Headers and license information added to the top of any new code files\n - HISTORY.md updated if the changes are big or user-facing\n - All CI checks should be passing\n\nThank you again for your contributions!  :+1:"

const stickerComment = "Hello there!  Thanks for your contribution.  I see that this is your first contribution to mlpack.  If you'd like to add your name to the list of contributors in `src/mlpack/core.hpp` and `COPYRIGHT.txt` and you haven't already, please feel free to push a change to this PR---or, if it gets merged before you can, feel free to open another PR.\n\nIn addition, if you'd like some stickers to put on your laptop, I'd be happy to help get them in the mail for you.  Just send an email with your physical mailing address to stickers@mlpack.org, and then one of the mlpack maintainers will put some stickers in an envelope for you.  It may take a few weeks to get them, depending on your location. :+1:"

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
    const issue = await github.issues.get(context.issue()).then((res) => res.data)

    if (issue.labels.length === 0)
    {
      await github.issues.addLabels(context.issue({ labels:
          ['s: unlabeled', 's: unanswered'] }))
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
        number: context.payload.pull_request.number,
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
