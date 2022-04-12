const schema = require('./schema')
const maxActionsPerRun = 30

module.exports = class Stale
{
  constructor (github, { owner, repo, logger = console, ...config })
  {
    this.github = github
    this.logger = logger
    this.remainingActions = 0

    const { error, value } = schema.validate(config)

    this.config = value
    if (error)
    {
      // Report errors to sentry
      logger.warn({ err: new Error(error), owner, repo }, 'Invalid config')
    }

    Object.assign(this.config, { owner, repo })
  }

  async markAndSweep (type)
  {
    const { only } = this.config
    if (only && only !== type)
    {
      return
    }
    if (!this.getConfigValue(type, 'perform'))
    {
      return
    }

    this.logger.info("starting stale mark and sweep")

    const limitPerRun = this.getConfigValue(type, 'limitPerRun') ||
        maxActionsPerRun
    this.remainingActions = Math.min(limitPerRun, maxActionsPerRun)

    await this.ensureStaleLabelExists(type)

    const staleItems = (await this.getStale(type)).data.items

    await Promise.all(staleItems.filter(issue => !issue.locked).map(issue => {
      return this.mark(type, issue)
    }))

    const { owner, repo } = this.config
    const daysUntilClose = this.getConfigValue(type, 'daysUntilClose')

    if (daysUntilClose)
    {
      this.logger.trace({ owner, repo }, 'Configured to close stale issues')
      const closableItems = (await this.getClosable(type)).data.items

      await Promise.all(closableItems.filter(issue => !issue.locked).map(issue => {
        this.close(type, issue)
      }))
    }
    else
    {
      this.logger.trace({ owner, repo }, 'Configured to leave stale issues open')
    }
  }

  async autoApprove()
  {
    const { owner, repo } = this.config
    const query = `repo:${owner}/${repo} is:open is:pr review:required`
    const params = { q: query, sort: 'updated', order: 'desc',
        per_page: maxActionsPerRun }

    const results = (await this.github.search.issuesAndPullRequests(params)).data.items

    await Promise.all(results.filter(issue => !issue.locked).map(issue => {
      return this.approveIfNeeded(issue)
    }))
  }

  async approveIfNeeded(issue)
  {
    const { owner, repo } = this.config
    const perform = this.getConfigValue('pr', 'perform')
    const number = issue.number
    const timestamp = this.since(1) // 1 day timeout for approvals.
    const approvalComment = this.getConfigValue('pr', 'approvalComment')

    if (perform)
    {
      // Check if it has approvals.
      let reviews = await this.github.pulls.listReviews({
          owner: owner,
          repo: repo,
          pull_number: number });
      let page = 1;
      let approvals = [];

      do
      {
        approvals = approvals.concat(reviews.data.map(review => [review.state, review.author_association, review.user.login, review.submitted_at]).filter(
            data => data[0].toLowerCase() === 'approved' && data[1].toLowerCase() !== 'none' && new Date(data[3]) < timestamp))

        page++;
        reviews = await this.github.pulls.listReviews({
          owner: owner,
          repo: repo,
          pull_number: number,
          page: page });
      } while (reviews.data !== undefined && reviews.data.length != 0)

      // Get list of contributors team members.  This is hardcoded: the
      // contributors team has ID 1184429.
      let teamMembersResp = await this.github.teams.listMembersInOrg.endpoint.merge({
          org: owner,
          team_slug: "contributors",
          role: "all" });
      var teamMembersAll = [];
      var result_x = await this.github.paginate(teamMembersResp).then(members =>
          {
            for (var i = 0; i < members.length; i++)
            {
              teamMembersAll.push(members[i].login);
            }
            return members;
          });
      const teamMembers = [...new Set(teamMembersAll)];

      // Filter non-unique approvals.
      const approvalMap = new Map();
      const uniqueApprovals = [];
      for (const item of approvals)
      {
        if (!approvalMap.has(item[2]) && teamMembers.filter(u => u === item[2]).length >= 1)
        {
          approvalMap.set(item[2], true);
          uniqueApprovals.push(item);
        }
      }
      const alreadyApproved = uniqueApprovals.filter(data => data[0].toLowerCase() === 'approved' && data[2].toLowerCase() === 'mlpack-bot[bot]').length

      if (uniqueApprovals.length === 1 && alreadyApproved === 0)
      {
        const prParams = { owner, repo, number, event: "APPROVE", body: approvalComment }
        await this.github.pulls.createReview(prParams)
      }
    }
  }

  getStale (type)
  {
    const staleLabel = this.getConfigValue(type, 'staleLabel')
    const exemptLabels = this.getConfigValue(type, 'exemptLabels')
    const exemptProjects = this.getConfigValue(type, 'exemptProjects')
    const exemptMilestones = this.getConfigValue(type, 'exemptMilestones')
    const exemptAssignees = this.getConfigValue(type, 'exemptAssignees')
    const labels = [staleLabel].concat(exemptLabels)
    const queryParts = labels.map(label => `-label:"${label}"`)
    queryParts.push(Stale.getQueryTypeRestriction(type))

    queryParts.push(exemptProjects ? 'no:project' : '')
    queryParts.push(exemptMilestones ? 'no:milestone' : '')
    queryParts.push(exemptAssignees ? 'no:assignee' : '')

    const query = queryParts.join(' ')
    const days = this.getConfigValue(type, 'days') || this.getConfigValue(type, 
        'daysUntilStale')
    return this.search(type, days, query)
  }

  getClosable (type)
  {
    const staleLabel = this.getConfigValue(type, 'staleLabel')
    const queryTypeRestriction = Stale.getQueryTypeRestriction(type)
    const query = `label:"${staleLabel}" ${queryTypeRestriction}`
    const days = this.getConfigValue(type, 'days') || this.getConfigValue(type, 
        'daysUntilClose')
    return this.search(type, days, query)
  }

  static getQueryTypeRestriction (type)
  {
    if (type === 'pulls')
    {
      return 'is:pr'
    }
    else if (type === 'issues')
    {
      return 'is:issue'
    }
    throw new Error(
        `Unknown type: ${type}. Valid types are 'pulls' and 'issues'`)
  }

  search (type, days, query)
  {
    const { owner, repo } = this.config
    const timestamp = this.since(days).toISOString().replace(/\.\d{3}\w$/, '')
    query = `repo:${owner}/${repo} is:open updated:<${timestamp} ${query}`

    const params = { q: query, sort: 'updated', order: 'desc',
        per_page: maxActionsPerRun }

    this.logger.info(params, 'searching %s/%s for stale issues', owner, repo)
    return this.github.search.issuesAndPullRequests(params)
  }

  async mark (type, issue)
  {
    if (this.remainingActions === 0)
    {
      return
    }
    this.remainingActions--

    const { owner, repo } = this.config
    const perform = this.getConfigValue(type, 'perform')
    const staleLabel = this.getConfigValue(type, 'staleLabel')
    const markComment = this.getConfigValue(type, 'markComment')
    const number = issue.number

    if (perform)
    {
      this.logger.info('%s/%s#%d is being marked', owner, repo, number)
      if (markComment)
      {
        await this.github.issues.createComment({ owner, repo, number,
            body: markComment })
      }
      return this.github.issues.addLabels({ owner, repo, number,
          labels: [staleLabel] })
    }
    else
    {
      this.logger.info('%s/%s#%d would have been marked (dry-run)', owner, repo,
          number)
    }
  }

  async close (type, issue)
  {
    if (this.remainingActions === 0)
    {
      return
    }
    this.remainingActions--

    const { owner, repo } = this.config
    const perform = this.getConfigValue(type, 'perform')
    const closeComment = this.getConfigValue(type, 'closeComment')
    const number = issue.number

    if (perform)
    {
      this.logger.info('%s/%s#%d is being closed', owner, repo, number)
      if (closeComment)
      {
        await this.github.issues.createComment({ owner, repo, number,
            body: closeComment })
      }
      return this.github.issues.update({ owner, repo, number, state: 'closed' })
    }
    else
    {
      this.logger.info('%s/%s#%d would have been closed (dry-run)', owner, repo,
          number)
    }
  }

  async unmark (type, issue)
  {
    const { owner, repo } = this.config
    const perform = this.getConfigValue(type, 'perform')
    const staleLabel = this.getConfigValue(type, 'staleLabel')
    const unmarkComment = this.getConfigValue(type, 'unmarkComment')
    const number = issue.number

    if (perform)
    {
      this.logger.info('%s/%s#%d is being unmarked', owner, repo, number)

      if (unmarkComment)
      {
        await this.github.issues.createComment({ owner, repo, number,
            body: unmarkComment })
      }

      return this.github.issues.removeLabel({ owner, repo, number,
          name: staleLabel }).catch((err) =>
          {
            // ignore if it's a 404 because then the label was already removed
            if (err.code !== 404)
            {
              throw err
            }
          })
    }
    else
    {
      this.logger.info('%s/%s#%d would have been unmarked (dry-run)', owner,
          repo, number)
    }
  }

  // Returns true if at least one exempt label is present.
  hasExemptLabel (type, issue)
  {
    const exemptLabels = this.getConfigValue(type, 'exemptLabels')
    return issue.labels.some(label => exemptLabels.includes(label.name))
  }

  hasStaleLabel (type, issue)
  {
    const staleLabel = this.getConfigValue(type, 'staleLabel')
    return issue.labels.map(label => label.name).includes(staleLabel)
  }

  // returns a type-specific config value if it exists, otherwise returns the
  // top-level value.
  getConfigValue (type, key)
  {
    if (this.config[type] && typeof this.config[type][key] !== 'undefined')
    {
      return this.config[type][key]
    }
    return this.config[key]
  }

  async ensureStaleLabelExists (type)
  {
    const { owner, repo } = this.config
    const staleLabel = this.getConfigValue(type, 'staleLabel')

    return this.github.issues.getLabel({ owner, repo,
                                         name: staleLabel }).catch(() =>
        {
          return this.github.issues.createLabel({ owner, repo,
              name: staleLabel, color: 'ffffff' })
        })
  }

  since (days)
  {
    const ttl = days * 24 * 60 * 60 * 1000
    let date = new Date(new Date() - ttl)

    // GitHub won't allow it
    if (date < new Date(0))
    {
      date = new Date(0)
    }
    return date
  }
}
