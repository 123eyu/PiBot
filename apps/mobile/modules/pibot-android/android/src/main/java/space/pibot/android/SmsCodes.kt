package space.pibot.android

import kotlin.math.abs

/**
 * Picks the verification code out of one SMS. Only the code leaves this object; the
 * message text is never stored, logged or handed to JavaScript.
 */
internal object SmsCodes {
  private val digits = Regex("(?<![0-9A-Za-z])\\d{4,8}(?![0-9A-Za-z])")
  private val mixed =
    Regex("(?<![0-9A-Za-z])(?=[A-Za-z0-9]*\\d)(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{4,8}(?![0-9A-Za-z])")
  private val keywords =
    Regex(
      "(?i)code|otp|pin|passcode|验证码|校验码|动态码|驗證碼|認証|인증|código|codigo|kod|верификац|код",
    )

  /** The candidate closest to a "code" keyword; digits first, mixed tokens only near a keyword. */
  fun extract(body: String?): String? {
    if (body.isNullOrEmpty() || body.length > 2000) return null
    val near = keywords.findAll(body).map { it.range }.toList()
    fun distance(match: MatchResult): Int =
      near.minOfOrNull { k ->
        if (k.last < match.range.first) match.range.first - k.last
        else abs(k.first - match.range.last)
      } ?: Int.MAX_VALUE
    val numeric = digits.findAll(body).toList()
    val candidates = numeric.ifEmpty { if (near.isEmpty()) emptyList() else mixed.findAll(body).toList() }
    return candidates.minByOrNull { distance(it) }?.value
  }

  /** A hint that is a phone number narrows the consent sheet; anything else matches text. */
  fun phoneHint(hint: String?): String? {
    val value = hint?.trim() ?: return null
    return if (Regex("^\\+?[0-9 ()-]{3,20}$").matches(value)) value.filter { it.isDigit() || it == '+' } else null
  }

  fun last4(address: String?): String? {
    val digitsOnly = address?.filter { it.isDigit() } ?: return null
    return if (digitsOnly.length >= 4) digitsOnly.takeLast(4) else null
  }

  /** Text hints match the message or sender name; number hints the sender's digits. */
  fun matches(hint: String?, address: String?, body: String): Boolean {
    val value = hint?.trim()
    if (value.isNullOrEmpty()) return true
    val phone = phoneHint(value)
    if (phone != null) {
      val want = phone.filter { it.isDigit() }
      val have = address?.filter { it.isDigit() } ?: return false
      return want.length >= 4 && (have.endsWith(want.takeLast(minOf(want.length, 8))))
    }
    return body.contains(value, ignoreCase = true) || (address?.contains(value, ignoreCase = true) ?: false)
  }
}
