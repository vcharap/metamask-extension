const { inherits } = require('util')
const PersistentForm = require('../lib/persistent-form')
const h = require('react-hyperscript')

const ethAbi = require('ethereumjs-abi')
const ethUtil = require('ethereumjs-util')

const FromDropdown = require('./components/send/from-dropdown')
const ToAutoComplete = require('./components/send/to-autocomplete')
const CurrencyDisplay = require('./components/send/currency-display')
const MemoTextArea = require('./components/send/memo-textarea')
const GasFeeDisplay = require('./components/send/gas-fee-display-v2')

const {
  TOKEN_TRANSFER_FUNCTION_SIGNATURE,
} = require('./components/send/send-constants')

const {
  multiplyCurrencies,
  conversionGreaterThan,
  subtractCurrencies,
} = require('./conversion-util')
const {
  calcTokenAmount,
} = require('./token-util')
const {
  isBalanceSufficient,
  isTokenBalanceSufficient,
} = require('./components/send/send-utils')
const { isValidAddress } = require('./util')

module.exports = SendTransactionScreen

inherits(SendTransactionScreen, PersistentForm)
function SendTransactionScreen () {
  PersistentForm.call(this)

  this.state = {
    fromDropdownOpen: false,
    toDropdownOpen: false,
    errors: {
      to: null,
      amount: null,
    },
    gasLoadingError: false,
  }

  this.handleToChange = this.handleToChange.bind(this)
  this.handleAmountChange = this.handleAmountChange.bind(this)
  this.validateAmount = this.validateAmount.bind(this)
}

const getParamsForGasEstimate = function (selectedAddress, symbol, data) {
  const estimatedGasParams = {
    from: selectedAddress,
    gas: '746a528800',
  }

  if (symbol) {
    Object.assign(estimatedGasParams, { value: '0x0' })
  }

  if (data) {
    Object.assign(estimatedGasParams, { data })
  }

  return estimatedGasParams
}

SendTransactionScreen.prototype.updateSendTokenBalance = function (usersToken) {
  if (!usersToken) return

  const {
    selectedToken = {},
    updateSendTokenBalance,
  } = this.props
  const { decimals } = selectedToken || {}
  const tokenBalance = calcTokenAmount(usersToken.balance.toString(), decimals)

  updateSendTokenBalance(tokenBalance)
}

SendTransactionScreen.prototype.componentWillMount = function () {
  const {
    updateTokenExchangeRate,
    selectedToken = {},
  } = this.props

  const { symbol } = selectedToken || {}

  if (symbol) {
    updateTokenExchangeRate(symbol)
  }

  this.updateGas()
}

SendTransactionScreen.prototype.updateGas = function () {
  const {
    selectedToken = {},
    getGasPrice,
    estimateGas,
    selectedAddress,
    data,
    updateGasTotal,
    from,
    tokenContract,
    editingTransactionId,
    gasPrice,
    gasLimit,
  } = this.props

  const { symbol } = selectedToken || {}

  const tokenBalancePromise = tokenContract
    ? tokenContract.balanceOf(from.address)
    : Promise.resolve()
  tokenBalancePromise
      .then(usersToken => this.updateSendTokenBalance(usersToken))

  if (!editingTransactionId) {
    const estimateGasParams = getParamsForGasEstimate(selectedAddress, symbol, data)

    Promise
      .all([
        getGasPrice(),
        estimateGas(estimateGasParams),
      ])
      .then(([gasPrice, gas]) => {
        const newGasTotal = this.getGasTotal(gas, gasPrice)
        updateGasTotal(newGasTotal)
        this.setState({ gasLoadingError: false })
      })
      .catch(err => {
        this.setState({ gasLoadingError: true })
      })
  } else {
    const newGasTotal = this.getGasTotal(gasLimit, gasPrice)
    updateGasTotal(newGasTotal)
  }
}

SendTransactionScreen.prototype.getGasTotal = function (gasLimit, gasPrice) {
  return multiplyCurrencies(gasLimit, gasPrice, {
    toNumericBase: 'hex',
    multiplicandBase: 16,
    multiplierBase: 16,
  })
}

SendTransactionScreen.prototype.componentDidUpdate = function (prevProps) {
  const {
    from: { balance },
    gasTotal,
    tokenBalance,
    amount,
    selectedToken,
    network,
  } = this.props

  const {
    from: { balance: prevBalance },
    gasTotal: prevGasTotal,
    tokenBalance: prevTokenBalance,
    network: prevNetwork,
  } = prevProps

  const uninitialized = [prevBalance, prevGasTotal].every(n => n === null)

  const balanceHasChanged = balance !== prevBalance
  const gasTotalHasChange = gasTotal !== prevGasTotal
  const tokenBalanceHasChanged = selectedToken && tokenBalance !== prevTokenBalance
  const amountValidationChange = balanceHasChanged || gasTotalHasChange || tokenBalanceHasChanged

  if (!uninitialized) {
    if (amountValidationChange) {
      this.validateAmount(amount)
    }

    if (network !== prevNetwork && network !== 'loading') {
      this.updateGas()
    }
  }
}

SendTransactionScreen.prototype.renderHeader = function () {
  const { selectedToken, clearSend, goHome } = this.props
  const tokenText = selectedToken ? 'tokens' : 'ETH'

  return h('div.page-container__header', [

    h('div.page-container__title', selectedToken ? 'Send Tokens' : 'Send ETH'),

    h('div.page-container__subtitle', `Only send ${tokenText} to an Ethereum address.`),

    h('div.page-container__header-close', {
      onClick: () => {
        clearSend()
        goHome()
      },
    }),

  ])
}

SendTransactionScreen.prototype.renderErrorMessage = function (errorType) {
  const { errors } = this.props
  const errorMessage = errors[errorType]

  return errorMessage
    ? h('div.send-v2__error', [ errorMessage ])
    : null
}

SendTransactionScreen.prototype.handleFromChange = async function (newFrom) {
  const {
    updateSendFrom,
    tokenContract,
  } = this.props

  if (tokenContract) {
    const usersToken = await tokenContract.balanceOf(newFrom.address)
    this.updateSendTokenBalance(usersToken)
  }
  updateSendFrom(newFrom)
}

SendTransactionScreen.prototype.renderFromRow = function () {
  const {
    from,
    fromAccounts,
    conversionRate,
  } = this.props

  const { fromDropdownOpen } = this.state

  return h('div.send-v2__form-row', [

    h('div.send-v2__form-label', 'From:'),

    h('div.send-v2__form-field', [
      h(FromDropdown, {
        dropdownOpen: fromDropdownOpen,
        accounts: fromAccounts,
        selectedAccount: from,
        onSelect: newFrom => this.handleFromChange(newFrom),
        openDropdown: () => this.setState({ fromDropdownOpen: true }),
        closeDropdown: () => this.setState({ fromDropdownOpen: false }),
        conversionRate,
      }),
    ]),

  ])
}

SendTransactionScreen.prototype.handleToChange = function (to) {
  const {
    updateSendTo,
    updateSendErrors,
    from: {address: from},
  } = this.props
  let toError = null

  if (!to) {
    toError = 'Required'
  } else if (!isValidAddress(to)) {
    toError = 'Recipient address is invalid'
  } else if (to === from) {
    toError = 'From and To address cannot be the same'
  }

  updateSendTo(to)
  updateSendErrors({ to: toError })
}

SendTransactionScreen.prototype.renderToRow = function () {
  const { toAccounts, errors, to } = this.props

  const { toDropdownOpen } = this.state

  return h('div.send-v2__form-row', [

    h('div.send-v2__form-label', [

      'To:',

      this.renderErrorMessage('to'),

    ]),

    h('div.send-v2__form-field', [
      h(ToAutoComplete, {
        to,
        accounts: Object.entries(toAccounts).map(([key, account]) => account),
        dropdownOpen: toDropdownOpen,
        openDropdown: () => this.setState({ toDropdownOpen: true }),
        closeDropdown: () => this.setState({ toDropdownOpen: false }),
        onChange: this.handleToChange,
        inError: Boolean(errors.to),
      }),
    ]),

  ])
}

SendTransactionScreen.prototype.handleAmountChange = function (value) {
  const amount = value
  const { updateSendAmount, setMaxModeTo } = this.props

  setMaxModeTo(false)
  this.validateAmount(amount)
  updateSendAmount(amount)
}

SendTransactionScreen.prototype.setAmountToMax = function () {
  const {
    from: { balance },
    updateSendAmount,
    updateSendErrors,
    tokenBalance,
    selectedToken,
    gasTotal,
  } = this.props
  const { decimals } = selectedToken || {}
  const multiplier = Math.pow(10, Number(decimals || 0))

  const maxAmount = selectedToken
    ? multiplyCurrencies(tokenBalance, multiplier, {toNumericBase: 'hex'})
    : subtractCurrencies(
      ethUtil.addHexPrefix(balance),
      ethUtil.addHexPrefix(gasTotal),
      { toNumericBase: 'hex' }
    )

  updateSendErrors({ amount: null })

  updateSendAmount(maxAmount)
}

SendTransactionScreen.prototype.validateAmount = function (value) {
  const {
    from: { balance },
    updateSendErrors,
    amountConversionRate,
    conversionRate,
    primaryCurrency,
    selectedToken,
    gasTotal,
    tokenBalance,
  } = this.props
  const { decimals } = selectedToken || {}
  const amount = value

  let amountError = null

  let sufficientBalance = true

  if (gasTotal) {
    sufficientBalance = isBalanceSufficient({
      amount: selectedToken ? '0x0' : amount,
      gasTotal,
      balance,
      primaryCurrency,
      amountConversionRate,
      conversionRate,
    })
  }

  const verifyTokenBalance = selectedToken && tokenBalance !== null
  let sufficientTokens
  if (verifyTokenBalance) {
    sufficientTokens = isTokenBalanceSufficient({
      tokenBalance,
      amount,
      decimals,
    })
  }

  const amountLessThanZero = conversionGreaterThan(
    { value: 0, fromNumericBase: 'dec' },
    { value: amount, fromNumericBase: 'hex' },
  )

  if (conversionRate && !sufficientBalance) {
    amountError = 'Insufficient funds.'
  } else if (verifyTokenBalance && !sufficientTokens) {
    amountError = 'Insufficient tokens.'
  } else if (amountLessThanZero) {
    amountError = 'Can not send negative amounts of ETH.'
  }

  updateSendErrors({ amount: amountError })
}

SendTransactionScreen.prototype.renderAmountRow = function () {
  const {
    selectedToken,
    primaryCurrency = 'ETH',
    convertedCurrency,
    amountConversionRate,
    errors,
    amount,
    setMaxModeTo,
    maxModeOn,
    gasTotal,
  } = this.props

  return h('div.send-v2__form-row', [

    h('div.send-v2__form-label', [
      'Amount:',
      this.renderErrorMessage('amount'),
      !errors.amount && gasTotal && h('div.send-v2__amount-max', {
        onClick: (event) => {
          event.preventDefault()
          setMaxModeTo(true)
          this.setAmountToMax()
        },
      }, [ !maxModeOn ? 'Max' : '' ]),
    ]),

    h('div.send-v2__form-field', [
      h(CurrencyDisplay, {
        inError: Boolean(errors.amount),
        primaryCurrency,
        convertedCurrency,
        selectedToken,
        value: amount || '0x0',
        conversionRate: amountConversionRate,
        handleChange: this.handleAmountChange,
      }),
    ]),

  ])
}

SendTransactionScreen.prototype.renderGasRow = function () {
  const {
    conversionRate,
    convertedCurrency,
    showCustomizeGasModal,
    gasTotal,
  } = this.props
  const { gasLoadingError } = this.state

  return h('div.send-v2__form-row', [

    h('div.send-v2__form-label', 'Gas fee:'),

    h('div.send-v2__form-field', [

      h(GasFeeDisplay, {
        gasTotal,
        conversionRate,
        convertedCurrency,
        onClick: showCustomizeGasModal,
        gasLoadingError,
      }),

    ]),

  ])
}

SendTransactionScreen.prototype.renderMemoRow = function () {
  const { updateSendMemo, memo } = this.props

  return h('div.send-v2__form-row', [

    h('div.send-v2__form-label', 'Transaction Memo:'),

    h('div.send-v2__form-field', [
      h(MemoTextArea, {
        memo,
        onChange: (event) => updateSendMemo(event.target.value),
      }),
    ]),

  ])
}

SendTransactionScreen.prototype.renderForm = function () {
  return h('div.send-v2__form', {}, [

    this.renderFromRow(),

    this.renderToRow(),

    this.renderAmountRow(),

    this.renderGasRow(),

    // this.renderMemoRow(),

  ])
}

SendTransactionScreen.prototype.renderFooter = function () {
  const {
    goHome,
    clearSend,
    gasTotal,
    tokenBalance,
    selectedToken,
    errors: { amount: amountError, to: toError },
  } = this.props

  const missingTokenBalance = selectedToken && !tokenBalance
  const noErrors = !amountError && toError === null

  return h('div.page-container__footer', [
    h('button.btn-cancel.page-container__footer-button', {
      onClick: () => {
        clearSend()
        goHome()
      },
    }, 'Cancel'),
    h('button.btn-clear.page-container__footer-button', {
      disabled: !noErrors || !gasTotal || missingTokenBalance,
      onClick: event => this.onSubmit(event),
    }, 'Next'),
  ])
}

SendTransactionScreen.prototype.render = function () {
  return (

    h('div.page-container', [

      this.renderHeader(),

      this.renderForm(),

      this.renderFooter(),
    ])

  )
}

SendTransactionScreen.prototype.addToAddressBookIfNew = function (newAddress) {
  const { toAccounts, addToAddressBook } = this.props
  if (!toAccounts.find(({ address }) => newAddress === address)) {
    // TODO: nickname, i.e. addToAddressBook(recipient, nickname)
    addToAddressBook(newAddress)
  }
}

SendTransactionScreen.prototype.getEditedTx = function () {
  const {
    from: {address: from},
    to,
    amount,
    gasLimit: gas,
    gasPrice,
    selectedToken,
    editingTransactionId,
    unapprovedTxs,
  } = this.props

  const editingTx = {
    ...unapprovedTxs[editingTransactionId],
    txParams: {
      from: ethUtil.addHexPrefix(from),
      gas: ethUtil.addHexPrefix(gas),
      gasPrice: ethUtil.addHexPrefix(gasPrice),
    },
  }

  if (selectedToken) {
    const data = TOKEN_TRANSFER_FUNCTION_SIGNATURE + Array.prototype.map.call(
      ethAbi.rawEncode(['address', 'uint256'], [to, ethUtil.addHexPrefix(amount)]),
      x => ('00' + x.toString(16)).slice(-2)
    ).join('')

    Object.assign(editingTx.txParams, {
      value: ethUtil.addHexPrefix('0'),
      to: ethUtil.addHexPrefix(selectedToken.address),
      data,
    })
  } else {
    const data = unapprovedTxs[editingTransactionId].txParams.data
    Object.assign(editingTx.txParams, {
      value: ethUtil.addHexPrefix(amount),
      to: ethUtil.addHexPrefix(to),
      data,
    })
  }

  return editingTx
}

SendTransactionScreen.prototype.onSubmit = function (event) {
  event.preventDefault()
  const {
    from: {address: from},
    to,
    amount,
    gasLimit: gas,
    gasPrice,
    signTokenTx,
    signTx,
    updateTx,
    selectedToken,
    editingTransactionId,
    errors: { amount: amountError, to: toError },
  } = this.props

  const noErrors = !amountError && toError === null

  if (!noErrors) {
    return
  }

  this.addToAddressBookIfNew(to)

  if (editingTransactionId) {
    const editedTx = this.getEditedTx()

    updateTx(editedTx)
  } else {

    const txParams = {
      from,
      value: '0',
      gas,
      gasPrice,
    }

    if (!selectedToken) {
      txParams.value = amount
      txParams.to = to
    }

    selectedToken
      ? signTokenTx(selectedToken.address, to, amount, txParams)
      : signTx(txParams)
  }
}
