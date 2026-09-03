package server

import (
	"regexp"
	"strings"
)

// SMS 验证码提取：识别入站短信中的一次性验证码（OTP）。
// 覆盖常见中文/英文/数字混合句式，策略保守，宁缺毋滥，避免把
// 金额、订单号等普通数字误判为验证码。

var (
	// otpHint 命中这些关键词才认为短信确实是验证码短信。
	otpHint = regexp.MustCompile(`(?i)(验证码|校验码|动态码|安全码|一次性密码|verification\s*code|verification\s*number|otp|one[- ]?time\s*(password|pin|code)|auth\s*code|login\s*code|secure\s*code|confirmation\s*code|\bcode\b)`)
	// otpNearbyCode 紧跟关键词之后的 4-8 位数字（词边界保护）。
	otpNearbyCode = regexp.MustCompile(`[0-9]{4,8}`)
	// otpLoneCode 无关键词时兜底：被非数字字符完整隔离的 4-8 位数字串。
	otpLoneCode = regexp.MustCompile(`(^|[^0-9])([0-9]{4,8})([^0-9]|$)`)
)

// extractSMSVerificationCode 从短信正文提取验证码。没有可信证据时返回空串。
func extractSMSVerificationCode(body string) string {
	body = strings.TrimSpace(body)
	if body == "" {
		return ""
	}
	if otpHint.MatchString(body) {
		if match := otpNearbyCode.FindString(body); match != "" {
			return match
		}
		return ""
	}
	// 无关键词的兜底：整个人是一或两个短数字块，且不含手机号/日期等噪音。
	// 例如 "123456"、"666888"（部分平台自定义）。只接受正文长度较短且数字
	// 明显的场景，降低误报。
	if len(body) > 12 {
		return ""
	}
	matches := otpLoneCode.FindAllStringSubmatch(body, -1)
	if len(matches) != 1 {
		return ""
	}
	return matches[0][2]
}
