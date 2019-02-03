const staleConfig = {
    daysUntilStale: 30,
    daysUntilClose: 7,
    exemptLabels: [ 's: keep-open' ],
    exemptProjects: true,
    exemptMilestones: true,
    exemptAssignees: false,
    staleLabel: 's: stale',
    markComment: 'This issue has been automatically marked as stale because it has not had any recent activity.  It will be closed in 7 days if no further activity occurs.  Thank you for your contributions! :+1:',
    limitPerRun: 30,
    approvalComment: "Second approval provided automatically after 24 hours. :+1:"
};

const createScheduler = require('probot-scheduler')
const Stale = require('./lib/stale')

const newPRWelcomeComment = "Thanks for opening your first pull request in this repository!  Someone will review it when they have a chance.  In the mean time, please be sure that you've handled the following things, to make the review process quicker and easier:\n\n - All code should follow the [style guide](https://github.com/mlpack/mlpack/wiki/DesignGuidelines#style-guidelines)\n - Documentation added for any new functionality\n - Tests added for any new functionality\n - Headers and license information added to the top of any new code files\n - HISTORY.md updated if the changes are big or user-facing\n - All CI checks should be passing\n\nThank you again for your contributions!  :+1:"

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
    const response = await context.github.issues.getForRepo(context.repo({
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
  const pullRequest = await context.github.pullRequests.get({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      number: context.payload.pull_request.number });

  const reviews = await context.github.pullRequests.getReviews({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      number: context.payload.pull_request.number });

  const approvals = reviews.data.map(review => [review.state, review.author_association]).filter(
      data => data[0].toLowerCase() === 'approved' && data[1].toLowerCase() === 'member').length

  context.log("approvals:")
  context.log(approvals)

  // Only post after the second approval.
  if (approvals === 2)
  {
    // The PR is approved.  Now, has this user ever had a PR merged before?
    const creator = context.payload.pull_request.user.login;
    const { owner, repo } = context.repo();
    const res = await context.github.search.issues({
        q: `is:pr is:merged author:${creator} repo:${owner}/${repo}` })
    const mergedPRs = res.data.items.filter(
        pr => pr.number !== context.payload.pull_request.number).length

    // But what if we have already sent a sticker notification?
    if (mergedPRs === 0)
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
